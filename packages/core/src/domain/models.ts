// Provider and model identity shared by every layer.
import type { ModelDetails } from "@inference-router/core/domain/model-details.ts";

export type ProviderId = "claude" | "antigravity" | "openai" | "openrouter" | "opencode" | "opencode-go" | "cheaper-inference";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "antigravity", "openai", "openrouter", "opencode", "opencode-go", "cheaper-inference"];

/**
 * Providers signed in with a consumer subscription (plan D4: usable only with `acknowledgeTermsRisk: true`). The others
 * are API-key gateways (plan P4.6, decision N1).
 */
export const SUBSCRIPTION_PROVIDERS: readonly ProviderId[] = ["claude", "antigravity", "openai"];

export type Dialect = "anthropic" | "openai" | "gemini";

/**
 * The request format of one route (plan P4.6 §2): `/anthropic/v1/messages*` → anthropic-messages,
 * `/openai/v1/chat/completions` → openai-chat, `/openai/v1/responses` → openai-responses, `/gemini/v1beta/models/*` →
 * gemini. A model serves some formats natively; a request in any other format answers unsupported_feature (the router
 * does not translate between formats: P5 cancelled, plan 2026-10-16 D1-A).
 */
export type WireFormat = "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini";

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** A routable model: `<provider>/<model>` on the wire, e.g. `antigravity/gemini-3-pro`. */
export type ModelAddress = { readonly provider: ProviderId; readonly model: string };

export function formatModelAddress(address: ModelAddress): string {
  return `${address.provider}/${address.model}`;
}

export type ModelInfo = {
  readonly address: ModelAddress;
  readonly displayName: string;
  /** Context window in tokens, when the provider's catalog states it. */
  readonly contextWindow?: number;
  /** Maximum output tokens, when the provider's catalog states it. */
  readonly maxOutputTokens?: number;
  /** RFC 3339 release date, when the provider's catalog states it (the Antigravity catalog has none). */
  readonly createdAt?: string;
  /** The model's own native formats when they differ per model (gateways); absent: the catalog's `formats`. */
  readonly formats?: readonly WireFormat[];
  /** What the provider's own list states beyond these fields (plan 2026-10-16 C3); absent: nothing more. */
  readonly details?: ModelDetails;
};

/** Where a model list came from: fetched now, a stored copy, or the built-in minimum (P0-LIVE plan §7). */
export type ModelsSource = "live" | "cache" | "static";

/**
 * A provider's list in a listing of every provider: a source, or `unavailable` when the provider could not list its
 * models (no account, or no list and no built-in copy); that provider's error is then in `error` (plan 2026-10-16 C4).
 */
export type CatalogSource = ModelsSource | "unavailable";

export type ModelCatalog = {
  readonly provider: ProviderId;
  /** The formats every model of the provider serves natively, unless a model states its own `formats`. */
  readonly formats: readonly WireFormat[];
  readonly source: CatalogSource;
  readonly models: readonly ModelInfo[];
  /** Why the provider is `unavailable`. */
  readonly error?: { readonly code: string; readonly message: string };
};

/** The native formats of one listed model. */
export function modelFormats(catalog: ModelCatalog, model: ModelInfo): readonly WireFormat[] {
  return model.formats ?? catalog.formats;
}
