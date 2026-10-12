// The daemon's route table (P4 plan §2.1). `GET /health` is open; every other route needs the router token, read
// from `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=` (the carriers of the three official SDKs).
// Each dialect prefix answers its own error shape; a path outside every prefix gets a plain JSON 404.
//
//   /anthropic  POST /v1/* (model from the body; claude serves /v1/messages and /v1/messages/count_tokens), GET /v1/models
//   /openai     GET /v1/models; POST /v1/chat/completions → unsupported_feature (both OpenAI cells are P5)
//   /gemini     GET /v1beta/models; POST /v1beta/models/{model}:{method} (model URL-encoded or raw, up to the last ':')
import { asRouterError, InvalidRequestError, RouteNotFoundError, RouterError, UnauthorizedError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import { parseJsonBody } from "@inference-router/core/domain/services/json-body.ts";
import { bodyOf, type RawRequest } from "@inference-router/core/domain/wire.ts";
import type { AccessPort } from "@inference-router/core/ports/inbound/access.ts";
import type { DialectCodecPort, EncodedResponse } from "@inference-router/core/ports/inbound/dialect.ts";
import type { HealthPort, ListModelsPort, PassthroughPort } from "@inference-router/core/ports/inbound/routing.ts";
import type { ErrorReporterPort } from "@inference-router/core/ports/inbound/diagnostics.ts";
import { HttpHandler, type InboundRequest, type OutboundResponse } from "@inference-router/router/adapters/inbound/http/http-handler.ts";

export const LOSSY_HEADER = "x-router-lossy";
export const MODELS_SOURCE_HEADER = "x-router-models-source";

export type RoutePorts = {
  readonly access: AccessPort;
  readonly passthrough: PassthroughPort;
  readonly models: ListModelsPort;
  readonly health: HealthPort;
};

/** The router token presented by the client, from the first carrier that has one. */
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
    const codec = this.codecs.find((c) => request.path === c.prefix || request.path.startsWith(`${c.prefix}/`));
    if (codec === undefined) {
      const error = new RouteNotFoundError(request.method, request.path);
      return encoded({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: error.code, message: error.message } }) });
    }
    try {
      if (!(await this.ports.access.authorize(presentedToken(request.headers, request.query)))) throw new UnauthorizedError();
      return await this.route(codec, request, request.path.slice(codec.prefix.length));
    } catch (error) {
      if (!(error instanceof RouterError)) this.errors.report(`${request.method} ${request.path} failed`, error);
      return encoded(codec.error(asRouterError(error)));
    }
  }

  private async route(codec: DialectCodecPort, request: InboundRequest, path: string): Promise<OutboundResponse> {
    const { method } = request;
    if (method === "GET" && ((codec.dialect !== "gemini" && path === "/v1/models") || (codec.dialect === "gemini" && path === "/v1beta/models"))) return this.models(codec);
    // Every Anthropic POST under /v1/ goes to the model's provider, which serves its native paths and rejects others.
    if (method === "POST" && codec.dialect === "anthropic" && path.startsWith("/v1/")) {
      const body = await request.readBody();
      return this.forward(codec, anthropicModel(body), request, path, body);
    }
    if (method === "POST" && codec.dialect === "openai" && path === "/v1/chat/completions") {
      throw new UnsupportedFeatureError(["chat_completions"], "openai dialect (both OpenAI cells are translated: P5)");
    }
    const gemini = codec.dialect === "gemini" && method === "POST" ? geminiModelRoute(path) : undefined;
    if (gemini !== undefined) return this.forward(codec, gemini.model, request, path, await request.readBody());
    throw new RouteNotFoundError(method, request.path);
  }

  private async models(codec: DialectCodecPort): Promise<OutboundResponse> {
    const catalogs = await this.ports.models.listModels();
    const response = codec.models(catalogs);
    return encoded({ ...response, headers: { ...response.headers, [MODELS_SOURCE_HEADER]: catalogs.map((c) => `${c.provider}=${c.source}`).join(",") } });
  }

  private async forward(codec: DialectCodecPort, model: string, request: InboundRequest, path: string, body: string): Promise<OutboundResponse> {
    const { key: _token, ...query } = request.query;
    const raw: RawRequest = { path, query, headers: request.headers, body, lossy: request.headers[LOSSY_HEADER] === "1", signal: request.signal };
    return this.ports.passthrough.forward(codec.dialect, model, raw);
  }
}

/** The Anthropic body's `model` (required by the Messages and Count Tokens APIs, anthropic-messages.md). */
function anthropicModel(body: string): string {
  const parsed = parseJsonBody(body);
  if (!isJsonObject(parsed) || typeof parsed.model !== "string") throw new InvalidRequestError("request body needs a string model (<provider>/<model> or an alias)");
  return parsed.model;
}
