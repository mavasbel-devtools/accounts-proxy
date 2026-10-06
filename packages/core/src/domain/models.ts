// Provider and model identity shared by every layer.

export type ProviderId = "claude-subscription" | "antigravity";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude-subscription", "antigravity"];

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
};
