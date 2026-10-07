// Provider-internal abstractions. Every Antigravity adapter depends only on these and the core ports;
// composition wires the implementations.
import { OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";
import type { AntigravityAccount, AuthTokens } from "@inference-router/provider-antigravity/domain/account.ts";
import type { ModelDescriptor } from "@inference-router/provider-antigravity/domain/catalog.ts";
import type { ChatChunk, ChatRequest, StreamEnvelope } from "@inference-router/provider-antigravity/domain/generate.ts";
import type { UsageView } from "@inference-router/provider-antigravity/domain/quota.ts";
import type { GenerateParams } from "@inference-router/provider-antigravity/domain/upstream.ts";

/** The cloudcode-pa `/v1internal:*` surface (every call carries the captured user agent, wire law 1). */
export abstract class AntigravityApiPort {
  abstract loadCodeAssist(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract onboardUser(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract fetchUserInfo(tokens: AuthTokens): Promise<{ readonly email?: string }>;
  abstract fetchAvailableModels(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract retrieveUserQuotaSummary(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract streamGenerate(params: GenerateParams, tokens: AuthTokens): AsyncIterable<StreamEnvelope>;
}

export abstract class AntigravityOAuthPort extends OAuthClientPort {
  abstract refresh(tokens: AuthTokens): Promise<AuthTokens>;
}

export type ActiveAccount = { readonly id: string; readonly account: AntigravityAccount };

export abstract class AntigravitySessionPort {
  /** Active account with ≥ the expiry buffer left (proactive refresh on EVERY path, single-flight + locked). */
  abstract active(): Promise<ActiveAccount>;
  /** Rotate regardless of the stored expiry (recovery after an upstream 401), persisting the result. */
  abstract forceRotate(current: ActiveAccount): Promise<ActiveAccount>;
}

/** Durable per-install state: the int64 session id and the thoughtSignature cache (wire laws 6, sessionId law). */
export abstract class AntigravityStatePort {
  abstract sessionId(): Promise<string>;
  abstract signatures(): Promise<Readonly<Record<string, string>>>;
  abstract saveSignature(callId: string, signature: string): Promise<void>;
}

export abstract class AntigravityCatalogPort {
  /** Live catalog (always fetched), memoized for `descriptor`. */
  abstract descriptors(): Promise<readonly ModelDescriptor[]>;
  /** Memoized lookup; fetches the catalog when the memo is empty or lacks the id. */
  abstract descriptor(wireId: string): Promise<ModelDescriptor | undefined>;
}

export abstract class AntigravityChatPort {
  abstract stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

/** A usage reporter whose report also carries the structured per-group view. */
export abstract class AntigravityQuotaPort extends UsageReporterPort {
  abstract override usage(): Promise<UsageView>;
}
