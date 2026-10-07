// Upstream wire envelope and failure classification for cloudcode-pa.
// Sources: opencode-antigravity-auth @ 5c6f7c2 AntigravityApiClientAdapter.ts (outer envelope, non-response law 10,
// dual transport law 3) and StreamChatUseCase.ts (transient geo-gate law 14).
import { QuotaExhaustedError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import type { StreamEnvelope } from "@inference-router/provider-antigravity/domain/generate.ts";

const PROVIDER = "antigravity";

export type GenerateParams = {
  readonly project: string;
  readonly requestId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly modelWireId: string;
};

/** Request envelope law 2: the Gemini request rides inside `request`; captured key order. */
export function outerEnvelope(params: GenerateParams): Record<string, unknown> {
  return {
    project: params.project,
    requestId: params.requestId,
    request: params.body,
    model: params.modelWireId,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

/**
 * Non-response law 10: every observed stream envelope carries `response` (or bare `candidates`); a 200 payload without
 * one must not end the stream as zero chunks. Router decision: it surfaces as upstream_error with HTTP 502 (the
 * upstream answered 200 with something that is not a generation), body kept for diagnosis.
 */
export function asResponseEnvelope(parsed: unknown): StreamEnvelope {
  if (parsed !== null && typeof parsed === "object") {
    if ("response" in parsed || "candidates" in parsed) return parsed as StreamEnvelope;
    throw new UpstreamError(PROVIDER, 502, `non-response payload: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  throw new UpstreamError(PROVIDER, 502, `non-object payload: ${String(parsed).slice(0, 500)}`);
}

/** RFC 9110 §10.2.3 Retry-After delta-seconds. An HTTP-date or garbage yields undefined (never guessed). */
export function retryAfterSeconds(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/**
 * A failed HTTP exchange. 429 → quota_exhausted with retry-after (plan D4: surfaced, never rotated). Other statuses
 * → upstream_error carrying the upstream status and body. Quota signalled only inside a 200/other body is not
 * classified here: no real capture of such a payload exists yet (P0-LIVE).
 */
export function upstreamFailure(status: number, body: string, retryAfterHeader: string | undefined): UpstreamError | QuotaExhaustedError {
  const retry = retryAfterSeconds(retryAfterHeader);
  if (status === 429) return new QuotaExhaustedError(PROVIDER, body.slice(0, 500), retry);
  return new UpstreamError(PROVIDER, status, body.slice(0, 500), retry);
}

/** Transient geo-gate law 14: 400 whose body contains the marker; retried only before any chunk was yielded. */
export function isLocationGate(error: unknown): boolean {
  return error instanceof UpstreamError && error.httpStatus === 400 && error.body.includes("User location is not supported");
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof UpstreamError && error.httpStatus === 401;
}
