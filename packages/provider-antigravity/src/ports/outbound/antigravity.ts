// Provider-internal abstractions. Every Antigravity adapter depends only on these and the core ports;
// composition wires the implementations.
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";
import { OAuthClientPort } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { OAuthSessionPort, Session } from "@accounts-proxy/core/ports/outbound/session.ts";
import { UsageReporterPort } from "@accounts-proxy/core/ports/outbound/usage.ts";
import type { AntigravityAccount, AuthTokens } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import type { ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { ChatMessage, StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import type { GeminiResponse, PreparedGemini } from "@accounts-proxy/provider-antigravity/domain/native-gemini.ts";
import type { UsageView } from "@accounts-proxy/provider-antigravity/domain/quota.ts";
import type { TrajectorySnapshot } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";
import type { GenerateParams } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";

/** The cloudcode-pa `/v1internal:*` surface (every call carries the captured user agent, wire law 1). */
export abstract class AntigravityApiPort {
  abstract loadCodeAssist(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract onboardUser(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract fetchUserInfo(tokens: AuthTokens): Promise<{ readonly email?: string }>;
  abstract fetchAvailableModels(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract retrieveUserQuotaSummary(tokens: AuthTokens): Promise<Record<string, unknown>>;
  abstract streamGenerate(params: GenerateParams, tokens: AuthTokens, signal: AbortSignal | undefined): AsyncIterable<StreamEnvelope>;
}

export abstract class AntigravityOAuthPort extends OAuthClientPort {
  abstract refresh(tokens: AuthTokens): Promise<AuthTokens>;
}

export type ActiveAccount = Session<AntigravityAccount>;

/** Active account with ≥ the expiry buffer left (proactive refresh on EVERY path); forceRenew after an upstream 401. */
export type AntigravitySessionPort = OAuthSessionPort<AntigravityAccount>;

/** Durable per-install state: the int64 session id and the thoughtSignature cache (wire laws 6, sessionId law). */
export abstract class AntigravityStatePort {
  abstract sessionId(): Promise<string>;
  abstract signatures(): Promise<Readonly<Record<string, string>>>;
  abstract saveSignature(callId: string, signature: string): Promise<void>;
}

export type AntigravityListing = { readonly source: ModelsSource; readonly descriptors: readonly ModelDescriptor[] };

export abstract class AntigravityCatalogPort {
  /** The signed-in account's kept list (shared model-list rules, plan 2026-10-28-13-40). */
  abstract listing(): Promise<AntigravityListing>;
  /** The list fetched now. */
  abstract refresh(): Promise<AntigravityListing>;
  /** A model of the kept list; a model the list lacks fetches the list once more. */
  abstract descriptor(wireId: string): Promise<ModelDescriptor | undefined>;
}

export type RunInput<T> = {
  readonly modelWireId: string;
  readonly modelEnum: string;
  /** The conversation as the trajectory sees it. */
  readonly turns: readonly ChatMessage[];
  /** The inner request for the trajectory snapshot (labels, requestId, sessionId) of this logical request. */
  readonly build: (snapshot: TrajectorySnapshot) => Readonly<Record<string, unknown>>;
  /** Maps each upstream envelope; every mapped envelope is yielded and counts as output (retry safety). */
  readonly map: (envelope: StreamEnvelope) => T;
  readonly signal?: AbortSignal | undefined;
};

/**
 * One logical generation through cloudcode-pa: the trajectory snapshot once, proactive refresh, one 401 rotation and
 * the transient geo-gate retries (law 14) — both only before anything was yielded — and the step counter after a
 * completed stream. Used by the native Gemini cell.
 */
export abstract class AntigravityRunnerPort {
  abstract run<T>(input: RunInput<T>): AsyncIterable<T>;
}

export type NativeInput = { readonly model: ModelDescriptor; readonly prepared: PreparedGemini; readonly signal: AbortSignal | undefined };

/** The near-native Gemini cell: public GenerateContentResponse objects, thought signatures cached (law 6). */
export abstract class AntigravityNativePort {
  /** The cached thoughtSignature per function-call id. */
  abstract signatures(): Promise<Readonly<Record<string, string>>>;
  abstract generate(input: NativeInput): AsyncIterable<GeminiResponse>;
}

/** A usage reporter whose report also carries the structured per-group view. */
export abstract class AntigravityQuotaPort extends UsageReporterPort {
  abstract override usage(): Promise<UsageView>;
}
