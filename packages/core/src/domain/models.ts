// Provider and model identity shared by every layer.

export type ProviderId = "claude" | "antigravity" | "openai";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "antigravity", "openai"];

export type Dialect = "anthropic" | "openai" | "gemini";

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
};

/** Where a model list came from: fetched now, a stored copy, or the built-in minimum (P0-LIVE plan §7). */
export type ModelsSource = "live" | "cache" | "static";

export type ModelCatalog = {
  readonly provider: ProviderId;
  /** The client dialect the provider serves natively (its models are generation targets only there until P5). */
  readonly nativeDialect: Dialect;
  readonly source: ModelsSource;
  readonly models: readonly ModelInfo[];
};
