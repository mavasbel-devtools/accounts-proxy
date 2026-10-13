// openai provider (ChatGPT plan usage). Native cell: OpenAI Responses (`POST /openai/v1/responses`). The client body is
// checked against the route's documented limits and always sent with `store: false`, `stream: true` (I2–I4, O7); the
// upstream stream goes back to a streaming client unchanged except the terminal response's missing output items (I6),
// and is aggregated into one response for the others (O8).
// The request carries opencode's session headers `session-id`, `thread-id`, `x-client-request-id` (I5, decision O9).
// Upstream errors (the `{"detail"}` admission bodies and the structured `error` objects) pass through with their
// status, body and request id (E1–E2). Translated cells (Anthropic/Chat/Gemini → OpenAI) arrive in P5.
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import { UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { isJsonObject, type JsonObject } from "@inference-router/core/domain/json.ts";
import type { ModelCatalog, WireFormat } from "@inference-router/core/domain/models.ts";
import { SseCodec } from "@inference-router/core/domain/services/event-stream.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import { parseJsonBody } from "@inference-router/core/domain/services/json-body.ts";
import { bodyOf, DROPPED_HEADER, readAll, type HttpResponse, type RawRequest } from "@inference-router/core/domain/wire.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { USER_AGENT } from "@inference-router/provider-openai/domain/constants.ts";
import { aggregate, prepareRequest, StreamRepair } from "@inference-router/provider-openai/domain/responses.ts";
import type { OpenAICatalogPort, OpenAIIdentityPort, OpenAISessionPort } from "@inference-router/provider-openai/ports/outbound/openai.ts";

export const NATIVE_PATH = "/v1/responses";

/** E1–E2: the status, body type, retry hint and request id reach the client. */
export function forwardedResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "content-type" || key === "retry-after" || key === "x-request-id") out[key] = value;
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
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  /** Translated-cell features: none until P5. */
  async nativeFormats(_model: string): Promise<ReadonlySet<WireFormat>> {
    return new Set(this.formats);
  }

  capabilities(): ReadonlySet<Feature> {
    return new Set<Feature>();
  }

  async models(): Promise<ModelCatalog> {
    const { source, entries } = await this.catalog.listing();
    return {
      provider: this.id,
      formats: this.formats,
      source,
      models: entries.map((e) => ({ address: { provider: this.id, model: e.id }, displayName: e.displayName, ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}) })),
    };
  }

  async *stream(_request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async countTokens(_request: CanonicalRequest): Promise<number> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    // The route table gives this provider only `POST /v1/responses` with a JSON-object body that names a model.
    const prepared = prepareRequest(parseJsonBody(request.body) as JsonObject, model, request.lossy);
    const { accessToken } = (await this.session.active()).account;
    const session = request.headers["session-id"] ?? this.identity.sessionId;
    const thread = request.headers["thread-id"] ?? session;
    const response = await this.transport.send({
      method: "POST",
      url: `${this.apiBase}${NATIVE_PATH}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": USER_AGENT,
        "session-id": session,
        "thread-id": thread,
        "x-client-request-id": request.headers["x-client-request-id"] ?? thread,
      },
      body: JSON.stringify(prepared.body),
      signal: request.signal,
    });
    const headers = forwardedResponseHeaders(response.headers);
    if (prepared.dropped.length > 0) headers[DROPPED_HEADER] = prepared.dropped.join(",");
    this.logger.info(`${this.id}: ${NATIVE_PATH} model=${model} (${prepared.clientStream ? "stream" : "aggregated"}) -> HTTP ${response.status}`);
    if (response.status !== 200) return { status: response.status, headers, body: response.body };
    if (prepared.clientStream) return { status: 200, headers, body: this.observe(response.body, model) };
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
