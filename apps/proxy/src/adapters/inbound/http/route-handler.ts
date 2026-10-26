// The daemon's route table (P4 plan §2.1). `GET /health` and `GET /.well-known/opencode` (it carries no secret, plan
// 2026-10-16 decision E1) are open; every other route needs the proxy token, read from `Authorization: Bearer`,
// `x-api-key`, `x-goog-api-key` or `?key=` (the carriers of the three official SDKs).
// Each dialect prefix answers its own error shape; the proxy's own routes and a path outside every prefix answer the
// plain JSON `{error: {code, message}}`.
//
//   /proxy/v1/models     GET: every enabled provider's models in detail (`?provider=<id>`: one provider)
//   /proxy/v1/models/refresh POST: the same, each list read now from its source (plan 2026-10-26 R2)
//   /opencode/config.json GET: the opencode v2 configuration of those models
//   /.well-known/opencode GET: the manifest of `opencode auth login <origin>`
//
//   /anthropic  POST /v1/* (format anthropic-messages, model from the body; the provider serves /v1/messages and, where
//               it has one, /v1/messages/count_tokens), GET /v1/models
//   /openai     GET /v1/models; POST /v1/chat/completions (openai-chat) and /v1/responses (openai-responses), model from
//               the body (plan P4.6 §2)
//   /gemini     GET /v1beta/models; POST /v1beta/models/{model}:{method} (gemini; model URL-encoded or raw, up to the last ':')
// Whether the model accepts the route's format natively is decided by its provider (PassthroughPort).
import { asProxyError, errorHeaders, InvalidRequestError, RouteNotFoundError, ProxyError, UnauthorizedError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import { isProviderId, type Dialect, type WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { parseJsonBody } from "@accounts-proxy/core/domain/services/json-body.ts";
import { bodyOf, type RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import type { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import type { DialectCodecPort, EncodedResponse } from "@accounts-proxy/core/ports/inbound/dialect.ts";
import type { OpencodeConfigPort, OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import { MODEL_REFRESH_PATH, type DescribeModelsPort, type HealthPort, type PassthroughPort, type RefreshModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ErrorReporterPort } from "@accounts-proxy/core/ports/inbound/diagnostics.ts";
import { HttpHandler, type InboundRequest, type OutboundResponse } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";

export const LOSSY_HEADER = "x-proxy-lossy";
export const MODELS_SOURCE_HEADER = "x-proxy-models-source";

export type RoutePorts = {
  readonly access: AccessPort;
  readonly passthrough: PassthroughPort;
  readonly health: HealthPort;
  readonly describe: DescribeModelsPort;
  readonly refresh: RefreshModelsPort;
  readonly opencode: OpencodeConfigPort;
  readonly origin: OpencodeOrigin;
};

export const WELL_KNOWN_PATH = "/.well-known/opencode";
export const OPENCODE_CONFIG_PATH = "/opencode/config.json";
export const DETAILED_MODELS_PATH = "/proxy/v1/models";

/** The proxy token presented by the client, from the first carrier that has one. */
export function presentedToken(headers: Readonly<Record<string, string>>, query: Readonly<Record<string, string>>): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers["authorization"] ?? "")?.[1]?.trim();
  return bearer ?? headers["x-api-key"] ?? headers["x-goog-api-key"] ?? query["key"];
}

/** `/v1beta/models/<model>:<method>` → the decoded model and the method; undefined for any other shape. */
export function geminiModelRoute(path: string): { readonly model: string; readonly method: string } | undefined {
  const match = /^\/v1beta\/models\/(.+):([A-Za-z]+)$/.exec(path);
  if (match === null) return undefined;
  let model: string;
  try {
    model = decodeURIComponent(match[1]!);
  } catch {
    throw new InvalidRequestError(`malformed model segment ${JSON.stringify(match[1])}`);
  }
  return { model, method: match[2]! };
}

const encoded = (response: EncodedResponse): OutboundResponse => ({ status: response.status, headers: response.headers, body: bodyOf(response.body) });
const json = (value: unknown): OutboundResponse => encoded({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const plainError = (error: ProxyError): OutboundResponse => encoded({ status: error.httpStatus, headers: errorHeaders(error), body: JSON.stringify({ error: { code: error.code, message: error.message } }) });

export class RouteHandler extends HttpHandler {
  constructor(
    private readonly codecs: readonly DialectCodecPort[],
    private readonly ports: RoutePorts,
    private readonly errors: ErrorReporterPort,
  ) {
    super();
  }

  async handle(request: InboundRequest): Promise<OutboundResponse> {
    if (request.method === "GET" && request.path === "/health") {
      return encoded({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "ok", providers: this.ports.health.enabledProviders() }) });
    }
    if (request.method === "GET" && request.path === WELL_KNOWN_PATH) return json(this.ports.opencode.manifest(this.ports.origin));
    const own = request.path === OPENCODE_CONFIG_PATH || request.path === DETAILED_MODELS_PATH || request.path === MODEL_REFRESH_PATH;
    const codec = this.codecs.find((c) => request.path === c.prefix || request.path.startsWith(`${c.prefix}/`));
    if (codec === undefined && !own) return plainError(new RouteNotFoundError(request.method, request.path));
    try {
      if (!(await this.ports.access.authorize(presentedToken(request.headers, request.query)))) throw new UnauthorizedError();
      return own ? await this.own(request) : await this.route(codec!, request, request.path.slice(codec!.prefix.length));
    } catch (error) {
      // A request the client abandoned fails with the abort of its upstream call: nothing went wrong in the proxy, and
      // the answer below reaches no one (live L3, 2026-10-13: opencode cancels its side requests).
      if (!(error instanceof ProxyError) && !request.signal.aborted) this.errors.report(`${request.method} ${request.path} failed`, error);
      return own ? plainError(asProxyError(error)) : encoded(codec!.error(asProxyError(error)));
    }
  }

  /** The proxy's own token-protected routes (plain JSON errors). */
  private async own(request: InboundRequest): Promise<OutboundResponse> {
    const refresh = request.path === MODEL_REFRESH_PATH;
    if (request.method !== (refresh ? "POST" : "GET")) throw new RouteNotFoundError(request.method, request.path);
    if (request.path === OPENCODE_CONFIG_PATH) return json(this.ports.opencode.config(await this.ports.describe.describeModels(), this.ports.origin));
    const provider = request.query["provider"];
    if (provider !== undefined && !isProviderId(provider)) throw new InvalidRequestError(`unknown provider ${JSON.stringify(provider)}`);
    return json({ catalogs: await (refresh ? this.ports.refresh.refreshModels(provider) : this.ports.describe.describeModels(provider)) });
  }

  private async route(codec: DialectCodecPort, request: InboundRequest, path: string): Promise<OutboundResponse> {
    const { method } = request;
    if (method === "GET" && ((codec.dialect !== "gemini" && path === "/v1/models") || (codec.dialect === "gemini" && path === "/v1beta/models"))) return this.models(codec);
    // Every Anthropic POST under /v1/ goes to the model's provider, which serves its native paths and rejects others.
    const format = method === "POST" ? bodyRouteFormat(codec.dialect, path) : undefined;
    if (format !== undefined) {
      const body = await request.readBody();
      return this.forward(format, bodyModel(body), request, path, body);
    }
    const gemini = codec.dialect === "gemini" && method === "POST" ? geminiModelRoute(path) : undefined;
    if (gemini !== undefined) return this.forward("gemini", gemini.model, request, path, await request.readBody());
    throw new RouteNotFoundError(method, request.path);
  }

  private async models(codec: DialectCodecPort): Promise<OutboundResponse> {
    const catalogs = await this.ports.describe.describeModels();
    const response = codec.models(catalogs);
    return encoded({ ...response, headers: { ...response.headers, [MODELS_SOURCE_HEADER]: catalogs.map((c) => `${c.provider}=${c.source}`).join(",") } });
  }

  private async forward(format: WireFormat, model: string, request: InboundRequest, path: string, body: string): Promise<OutboundResponse> {
    const { key: _token, ...query } = request.query;
    const raw: RawRequest = { format, path, query, headers: request.headers, body, lossy: request.headers[LOSSY_HEADER] === "1", signal: request.signal };
    return this.ports.passthrough.forward(format, model, raw);
  }
}

/** The format of a POST route whose model is in the body (every Anthropic `/v1/*` route, Chat Completions, Responses). */
function bodyRouteFormat(dialect: Dialect, path: string): WireFormat | undefined {
  if (dialect === "anthropic" && path.startsWith("/v1/")) return "anthropic-messages";
  if (dialect === "openai" && path === "/v1/chat/completions") return "openai-chat";
  if (dialect === "openai" && path === "/v1/responses") return "openai-responses";
  return undefined;
}

/** The body's `model` (required by the Anthropic Messages / Count Tokens APIs and the OpenAI Chat and Responses APIs). */
function bodyModel(body: string): string {
  const parsed = parseJsonBody(body);
  if (!isJsonObject(parsed) || typeof parsed.model !== "string") throw new InvalidRequestError("request body needs a string model (<provider>/<model> or an alias)");
  return parsed.model;
}
