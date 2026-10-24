// openai provider (ChatGPT plan usage). Native cell: OpenAI Responses (`POST /openai/v1/responses`). The client body is
// checked against the route's documented limits and always sent with `store: false`, `stream: true` (I2–I4, O7); the
// upstream stream goes back to a streaming client unchanged except the terminal response's missing output items (I6),
// and is aggregated into one response for the others (O8).
// The request carries opencode's session headers `session-id`, `thread-id`, `x-client-request-id` (I5, decision O9).
// Recon gaps P1–P3 (opencode v2.1.1 toward api.openai.com, recon runs opencode/2026-10-24-07-08-58, -07-09-06,
// -07-09-16): the body is zstd-compressed with `content-encoding: zstd`, as opencode's ChatGPT provider sends it toward
// its default address; the client's User-Agent and OpenCode's own headers are forwarded as sent (the proxy's own
// User-Agent only when the client sends none); no explicit `accept`. On the wire opencode sends, after the standard
// headers, its other headers ordered by name, so the proxy does the same.
// Upstream errors (the `{"detail"}` admission bodies and the structured `error` objects) pass through with their
// status, body and request id (E1–E2). Rule I7 (live 2026-10-13 and 2026-10-17, captures
// tests/fixtures/captures/p0-live/l1/openai-resp-*.json): plan usage answers its event stream with no `content-type` and
// names the request in `x-oai-request-id`; a streaming client gets `content-type: text/event-stream` (the upstream's own
// value when it sends one) and the request id.
import { isJsonObject, type JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ModelCatalog, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { SseCodec } from "@accounts-proxy/core/domain/services/event-stream.ts";
import { parseJsonBody } from "@accounts-proxy/core/domain/services/json-body.ts";
import { bodyOf, DROPPED_HEADER, readAll, type HttpResponse, type RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { OPENCODE_CLIENT_HEADERS } from "@accounts-proxy/core/domain/opencode-client.ts";
import { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import type { LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { ContentEncoderPort, HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { USER_AGENT } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { aggregate, prepareRequest, StreamRepair } from "@accounts-proxy/provider-openai/domain/responses.ts";
import type { OpenAICatalogPort, OpenAIIdentityPort, OpenAISessionPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

export const NATIVE_PATH = "/v1/responses";
const FORWARDED = ["content-type", "retry-after", "x-request-id", "x-oai-request-id"];
/** P2: OpenCode's own headers after the User-Agent, forwarded when the client sends them. */
const CLIENT_HEADERS = OPENCODE_CLIENT_HEADERS.filter((name) => name !== "user-agent");
/** I7: the type of a stream the upstream sent without one. */
export const STREAM_CONTENT_TYPE = "text/event-stream";

/** E1–E2, I7: the status, body type, retry hint and request id (`x-request-id`, plan usage's `x-oai-request-id`) reach the client. */
export function forwardedResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (FORWARDED.includes(key)) out[key] = value;
  }
  return out;
}

/** The JSON data of every SSE frame (frames that are not JSON objects are skipped). */
export function sseEvents(text: string): JsonObject[] {
  const codec = new SseCodec();
  const out: JsonObject[] = [];
  for (const frame of codec.push(`${text}\n\n`)) {
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (isJsonObject(value)) out.push(value);
  }
  return out;
}

export class OpenAIProvider extends ProviderPort {
  readonly id = "openai";
  /** The one format this provider serves natively, for every model. */
  readonly formats: readonly WireFormat[] = ["openai-responses"];

  constructor(
    private readonly session: OpenAISessionPort,
    private readonly catalog: OpenAICatalogPort,
    private readonly identity: OpenAIIdentityPort,
    private readonly transport: HttpTransportPort,
    private readonly encoder: ContentEncoderPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  async nativeFormats(_model: string): Promise<ReadonlySet<WireFormat>> {
    return new Set(this.formats);
  }

  async models(): Promise<ModelCatalog> {
    const { source, entries } = await this.catalog.listing();
    return {
      provider: this.id,
      formats: this.formats,
      source,
      models: entries.map((e) => ({ address: { provider: this.id, model: e.id }, displayName: e.displayName })),
    };
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    // The route table gives this provider only `POST /v1/responses` with a JSON-object body that names a model.
    const prepared = prepareRequest(parseJsonBody(request.body) as JsonObject, model, request.lossy);
    const { accessToken } = (await this.session.active()).account;
    const session = request.headers["session-id"] ?? this.identity.sessionId;
    const thread = request.headers["thread-id"] ?? session;
    const named: Record<string, string> = { "session-id": session, "thread-id": thread, "x-client-request-id": request.headers["x-client-request-id"] ?? thread };
    for (const name of CLIENT_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) named[name] = value;
    }
    const response = await this.transport.send({
      method: "POST",
      url: `${this.apiBase}${NATIVE_PATH}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-encoding": this.encoder.encoding,
        "content-type": "application/json",
        "user-agent": request.headers["user-agent"] ?? USER_AGENT,
        ...Object.fromEntries(Object.keys(named).sort().map((name) => [name, named[name]!])),
      },
      body: this.encoder.encode(JSON.stringify(prepared.body)),
      signal: request.signal,
    });
    const headers = forwardedResponseHeaders(response.headers);
    if (prepared.dropped.length > 0) headers[DROPPED_HEADER] = prepared.dropped.join(",");
    this.logger.info(`${this.id}: ${NATIVE_PATH} model=${model} (${prepared.clientStream ? "stream" : "aggregated"}) -> HTTP ${response.status}`);
    if (response.status !== 200) return { status: response.status, headers, body: response.body };
    if (prepared.clientStream) return { status: 200, headers: { "content-type": STREAM_CONTENT_TYPE, ...headers }, body: this.observe(response.body, model) };
    const result = aggregate(sseEvents(await readAll(response.body)));
    const json = { ...headers, "content-type": "application/json" };
    if (result.kind === "error") {
      this.logger.warn(`${this.id}: model=${model} failed after the stream opened: HTTP ${result.status}`);
      return { status: result.status, headers: json, body: bodyOf(JSON.stringify(result.body)) };
    }
    return { status: 200, headers: json, body: bodyOf(JSON.stringify(result.response)) };
  }

  /** Yields the upstream frames as they complete (I6 fills the terminal response) and logs the terminal event (I2). */
  private async *observe(body: AsyncIterable<Uint8Array>, model: string): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const repair = new StreamRepair();
    let finished = false;
    try {
      for await (const chunk of body) {
        const frames = repair.push(decoder.decode(chunk, { stream: true }));
        if (frames !== "") yield encoder.encode(frames);
      }
      const rest = repair.push(decoder.decode()) + repair.flush();
      if (rest !== "") yield encoder.encode(rest);
      finished = true;
    } finally {
      // A client that stops reading after the terminal event (the AI SDK, live L3) still gets its line in the log.
      this.logger.info(`${this.id}: stream ${finished ? "end" : "closed by the client"} model=${model} terminal=${repair.terminal}`);
    }
  }
}
