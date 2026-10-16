// claude provider. Native cell (Anthropic Messages): the client body passes through the captured
// claude envelope + never-prefill guard (domain/request-transform.ts) and the upstream response is STREAMED back
// chunk by chunk — fix F1 for the source relay, which awaited res.text() before answering
// (AnthropicApiClientAdapter.ts:45). F4: the client's anthropic-beta is honoured within the model's captured set and a
// client anthropic-version must be the captured one. A client disconnect aborts the upstream exchange (signal).
import { InvalidRequestError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { withDetails } from "@inference-router/core/domain/model-details.ts";
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import type { ModelCatalog, WireFormat } from "@inference-router/core/domain/models.ts";
import { SseCodec } from "@inference-router/core/domain/services/event-stream.ts";
import { parseJsonBody } from "@inference-router/core/domain/services/json-body.ts";
import { DROPPED_HEADER, readAll, type HttpResponse, type RawRequest } from "@inference-router/core/domain/wire.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { entryDetails } from "@inference-router/provider-claude/domain/catalog.ts";
import { ANTHROPIC_VERSION_HEADER } from "@inference-router/provider-claude/domain/constants.ts";
import type { ClaudeTokens } from "@inference-router/provider-claude/domain/credential.ts";
import { capturedBetaHeader, mergeBetaHeader, transformRequest, type WireRequestBody } from "@inference-router/provider-claude/domain/request-transform.ts";
import type { ClaudeCatalogPort, ClaudeIdentityPort, ClaudeSessionPort } from "@inference-router/provider-claude/ports/outbound/claude.ts";

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
  readonly id = "claude";
  /** The one format this provider serves natively, for every model. */
  readonly formats: readonly WireFormat[] = ["anthropic-messages"];

  constructor(
    private readonly session: ClaudeSessionPort,
    private readonly catalog: ClaudeCatalogPort,
    private readonly identity: ClaudeIdentityPort,
    private readonly transport: HttpTransportPort,
    private readonly random: RandomPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  /** Translated-cell features: empty until the P0-E3 fidelity matrix is measured (plan amendment A1). */
  async nativeFormats(_model: string): Promise<ReadonlySet<WireFormat>> {
    return new Set(this.formats);
  }

  async models(): Promise<ModelCatalog> {
    const { source, entries } = await this.catalog.listing();
    return {
      provider: this.id,
      formats: this.formats,
      source,
      models: entries.map((e) => ({
        address: { provider: this.id, model: e.id },
        displayName: e.displayName,
        ...(e.maxInputTokens > 0 ? { contextWindow: e.maxInputTokens } : {}),
        ...(e.maxTokens > 0 ? { maxOutputTokens: e.maxTokens } : {}),
        ...(e.createdAt !== "" ? { createdAt: e.createdAt } : {}),
        ...withDetails(entryDetails(e)),
      })),
    };
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    const path = Object.hasOwn(NATIVE_PATHS, request.path) ? NATIVE_PATHS[request.path]! : undefined;
    if (path === undefined) throw new InvalidRequestError(`${this.id} has no native route ${request.path}`);
    const parsed = parseJsonBody(request.body);
    if (!isJsonObject(parsed) || !Array.isArray(parsed["messages"])) {
      throw new InvalidRequestError("request body must be an object with a messages array");
    }
    const body = { ...parsed, model } as unknown as WireRequestBody;
    const dropped: string[] = [];
    const version = request.headers["anthropic-version"];
    if (version !== undefined && version !== ANTHROPIC_VERSION_HEADER) {
      const feature = `anthropic-version:${version}`;
      if (!request.lossy) throw new UnsupportedFeatureError([feature], `${this.id} (the captured client speaks anthropic-version ${ANTHROPIC_VERSION_HEADER})`);
      dropped.push(feature);
    }

    const active = await this.session.active();
    const entries = await this.catalog.entries();
    const lookup = (id: string) => entries.find((e) => e.id === id);
    const betas = mergeBetaHeader(request.headers["anthropic-beta"], capturedBetaHeader(model, lookup), request.lossy);
    dropped.push(...betas.dropped);
    const ids = { deviceId: await this.identity.deviceId(), previousMessageId: this.identity.previousMessageId(), ccPromptId: this.random.uuid(), clientRequestId: this.random.uuid() };
    const send = (tokens: ClaudeTokens) => {
      const upstream = transformRequest(
        { body, path, betaHeader: betas.header },
        { ...ids, accessToken: tokens.accessToken, accountUuid: tokens.accountUuid ?? "", sessionId: this.identity.sessionId },
        lookup,
        this.apiBase,
      );
      return this.transport.send({ method: "POST", url: upstream.url, headers: upstream.headers, body: upstream.body, signal: request.signal });
    };
    let response = await send(active.account);
    // Plan v4 H3/H-d (deviation from the source, which has no retry): a 401 means the stored expiry was wrong (clock
    // skew, server-side revocation). Nothing has reached the client yet, so renew once and resend the same request.
    if (response.status === 401 && active.account.refreshToken !== undefined) {
      await readAll(response.body);
      this.logger.info(`${this.id}: upstream 401; renewing the token once and retrying`);
      response = await send((await this.session.forceRenew(active)).account);
    }
    const headers = forwardedResponseHeaders(response.headers);
    if (dropped.length > 0) headers[DROPPED_HEADER] = dropped.join(",");
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
