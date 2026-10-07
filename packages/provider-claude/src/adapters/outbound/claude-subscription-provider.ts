// claude-subscription provider. Native cell (Anthropic Messages): the client body passes through the captured
// claude envelope + never-prefill guard (domain/request-transform.ts) and the upstream response is STREAMED back
// chunk by chunk — fix F1 for the source relay, which awaited res.text() before answering
// (AnthropicApiClientAdapter.ts:45). Translated cells (OpenAI/Gemini → Claude) arrive in P5.
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import { InvalidRequestError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import type { ModelInfo } from "@inference-router/core/domain/models.ts";
import { SseCodec } from "@inference-router/core/domain/services/event-stream.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { API_BASE } from "../../domain/constants.ts";
import { transformRequest, type WireRequestBody } from "../../domain/request-transform.ts";
import type { ClaudeCatalogPort, ClaudeIdentityPort, ClaudeSessionPort } from "../../ports/outbound/claude.ts";

/** Native routes (relative to the dialect prefix) → upstream path. */
export const NATIVE_PATHS: Readonly<Record<string, string>> = {
  "/v1/messages": "/v1/messages",
  "/v1/messages/count_tokens": "/v1/messages/count_tokens",
};

/** Upstream response headers a native Anthropic client relies on (body format, retry, request id, rate limits). */
export function forwardedResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "content-type" || key === "retry-after" || key === "request-id" || key.startsWith("anthropic-ratelimit-")) out[key] = value;
  }
  return out;
}

export class ClaudeSubscriptionProvider extends ProviderPort {
  readonly id = "claude-subscription";
  readonly nativeDialect = "anthropic";

  constructor(
    private readonly session: ClaudeSessionPort,
    private readonly catalog: ClaudeCatalogPort,
    private readonly identity: ClaudeIdentityPort,
    private readonly transport: HttpTransportPort,
    private readonly random: RandomPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string = API_BASE,
  ) {
    super();
  }

  /** Translated-cell features: empty until the P0-E3 fidelity matrix is measured (plan amendment A1). */
  capabilities(): ReadonlySet<Feature> {
    return new Set<Feature>();
  }

  async models(): Promise<readonly ModelInfo[]> {
    return (await this.catalog.entries()).map((e) => ({
      address: { provider: this.id, model: e.id },
      displayName: e.displayName,
      ...(e.maxInputTokens > 0 ? { contextWindow: e.maxInputTokens } : {}),
      ...(e.maxTokens > 0 ? { maxOutputTokens: e.maxTokens } : {}),
    }));
  }

  async *stream(_request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async countTokens(_request: CanonicalRequest): Promise<number> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    const path = Object.hasOwn(NATIVE_PATHS, request.path) ? NATIVE_PATHS[request.path]! : undefined;
    if (path === undefined) throw new InvalidRequestError(`${this.id} has no native route ${request.path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      throw new InvalidRequestError("request body is not valid JSON");
    }
    if (!isJsonObject(parsed) || !Array.isArray(parsed["messages"])) {
      throw new InvalidRequestError("request body must be an object with a messages array");
    }
    const body = { ...parsed, model } as unknown as WireRequestBody;

    const tokens = await this.session.freshTokens();
    const entries = await this.catalog.entries();
    const upstream = transformRequest(
      { body, path },
      {
        accessToken: tokens.accessToken,
        accountUuid: tokens.accountUuid ?? "",
        deviceId: await this.identity.deviceId(),
        sessionId: this.identity.sessionId,
        previousMessageId: this.identity.previousMessageId(),
        ccPromptId: this.random.uuid(),
        clientRequestId: this.random.uuid(),
      },
      (id) => entries.find((e) => e.id === id),
      this.apiBase,
    );
    const response = await this.transport.send({ method: "POST", url: upstream.url, headers: upstream.headers, body: upstream.body });
    const headers = forwardedResponseHeaders(response.headers);
    this.logger.info(`${this.id}: ${path} model=${model} -> HTTP ${response.status}`);
    const sse = (headers["content-type"] ?? "").includes("text/event-stream");
    return { status: response.status, headers, body: sse ? this.observe(response.body, model) : response.body };
  }

  /** Yields every upstream chunk unchanged while tracking message_start ids and the final stop_reason. */
  private async *observe(body: AsyncIterable<Uint8Array>, model: string): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder();
    const codec = new SseCodec();
    let stopReason = "none";
    const inspect = (text: string) => {
      for (const frame of codec.push(text)) {
        let event: { type?: unknown; message?: { id?: unknown }; delta?: { stop_reason?: unknown } };
        try {
          event = JSON.parse(frame.data) as typeof event;
        } catch {
          continue;
        }
        if (event.type === "message_start" && typeof event.message?.id === "string") this.identity.setPreviousMessageId(event.message.id);
        if (event.type === "message_delta" && typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
      }
    };
    for await (const chunk of body) {
      inspect(decoder.decode(chunk, { stream: true }));
      yield chunk;
    }
    inspect(decoder.decode());
    this.logger.info(`${this.id}: stream end model=${model} stop_reason=${stopReason}`);
    if (stopReason === "refusal") this.logger.warn(`${this.id}: upstream refusal (model=${model})`);
  }
}
