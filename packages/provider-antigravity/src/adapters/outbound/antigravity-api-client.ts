// cloudcode-pa transport. Port of opencode-antigravity-auth @ 5c6f7c2 AntigravityApiClientAdapter.ts over the
// streaming HttpTransportPort. Differences (asserted in tests):
//   A1 SSE framing uses the WHATWG SseCodec (CR/LF/CRLF, multi-line data joined) instead of a per-line splitter; for the
//      captured upstream format (one `data:` line per event) the decoded envelopes are identical.
//   A2 failures are core errors: 429 → quota_exhausted with Retry-After; other statuses → upstream_error (status kept).
import type { HttpResponse } from "@accounts-proxy/core/domain/wire.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { SseCodec } from "@accounts-proxy/core/domain/services/event-stream.ts";
import type { LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import type { AuthTokens } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import { IDE_METADATA, USER_AGENT } from "@accounts-proxy/provider-antigravity/domain/constants.ts";
import type { StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { asResponseEnvelope, outerEnvelope, upstreamFailure, type GenerateParams } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";
import { AntigravityApiPort } from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

const bearer = (tokens: AuthTokens) => `Bearer ${tokens.accessToken}`;

export class AntigravityApiClient extends AntigravityApiPort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly logger: LoggerPort,
    private readonly host: string,
    private readonly userinfoUrl: string,
  ) {
    super();
  }

  loadCodeAssist(tokens: AuthTokens): Promise<Record<string, unknown>> {
    return this.call("loadCodeAssist", tokens, { metadata: { ideType: IDE_METADATA.ideType } });
  }

  onboardUser(tokens: AuthTokens): Promise<Record<string, unknown>> {
    return this.call("onboardUser", tokens, {
      tier_id: "free-tier",
      metadata: { ide_type: IDE_METADATA.ideType, ide_version: IDE_METADATA.ideVersion, ide_name: IDE_METADATA.ideName },
    });
  }

  async fetchUserInfo(tokens: AuthTokens): Promise<{ readonly email?: string }> {
    const raw = await this.call("fetchUserInfo", tokens, {});
    const settings = raw["userSettings"];
    const fromSettings = settings !== null && typeof settings === "object" ? (settings as Record<string, unknown>)["email"] : undefined;
    if (typeof fromSettings === "string") return { email: fromSettings };
    const res = await this.transport.send({ method: "GET", url: this.userinfoUrl, headers: { authorization: bearer(tokens), "user-agent": USER_AGENT } });
    const text = await readAll(res.body);
    if (!ok(res)) throw upstreamFailure(res.status, text, res.headers["retry-after"]);
    const json = parseObject(text);
    return typeof json["email"] === "string" ? { email: json["email"] } : {};
  }

  fetchAvailableModels(tokens: AuthTokens): Promise<Record<string, unknown>> {
    return this.call("fetchAvailableModels", tokens, {});
  }

  retrieveUserQuotaSummary(tokens: AuthTokens): Promise<Record<string, unknown>> {
    return this.call("retrieveUserQuotaSummary", tokens, {});
  }

  async *streamGenerate(params: GenerateParams, tokens: AuthTokens, signal: AbortSignal | undefined): AsyncIterable<StreamEnvelope> {
    const res = await this.transport.send({
      method: "POST",
      url: `${this.host}/v1internal:streamGenerateContent?alt=sse`,
      // Header allowlist captured from the IDE's stream call (source G16).
      headers: { "content-type": "application/json", authorization: bearer(tokens), "user-agent": USER_AGENT, "accept-encoding": "gzip" },
      body: JSON.stringify(outerEnvelope(params)),
      signal,
    });
    if (!ok(res)) throw upstreamFailure(res.status, await readAll(res.body), res.headers["retry-after"]);
    if ((res.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
      const text = await readAll(res.body);
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new UpstreamError("antigravity", 502, `malformed JSON stream body: ${text.slice(0, 500)}`);
      }
      for (const envelope of Array.isArray(decoded) ? decoded : [decoded]) {
        if (envelope !== null && typeof envelope === "object") yield asResponseEnvelope(envelope);
        else this.logger.warn(`antigravity: dropping non-object JSON stream envelope (${typeof envelope})`);
      }
      return;
    }
    const decoder = new TextDecoder();
    const codec = new SseCodec();
    for await (const chunk of res.body) {
      for (const frame of codec.push(decoder.decode(chunk, { stream: true }))) {
        const payload = frame.data.trim();
        if (payload === "" || payload === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch (error) {
          this.logger.warn(`antigravity: dropping malformed SSE event (${String(error)})`);
          continue;
        }
        yield asResponseEnvelope(parsed);
      }
    }
  }

  private async call(op: string, tokens: AuthTokens, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.transport.send({
      method: "POST",
      url: `${this.host}/v1internal:${op}`,
      headers: { "content-type": "application/json", authorization: bearer(tokens), "user-agent": USER_AGENT },
      body: JSON.stringify(body),
    });
    const text = await readAll(res.body);
    if (!ok(res)) throw upstreamFailure(res.status, text, res.headers["retry-after"]);
    return parseObject(text);
  }
}

const ok = (res: HttpResponse) => res.status >= 200 && res.status < 300;

/** Source behaviour: an unparsable (or non-object) success body is treated as `{}`. */
function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
