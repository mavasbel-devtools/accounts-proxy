// Provider-internal abstractions. ClaudeSubscriptionProvider depends only on these; the adapters in
// adapters/outbound implement them and composition wires them.
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";
import { OAuthClientPort } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { OAuthSessionPort } from "@accounts-proxy/core/ports/outbound/session.ts";
import type { ClaudeTokens } from "@accounts-proxy/provider-claude/domain/credential.ts";
import type { CatalogModelEntry } from "@accounts-proxy/provider-claude/domain/model-envelope.ts";

export abstract class ClaudeOAuthPort extends OAuthClientPort {
  /** Rotate the access token (and the refresh token when the server issues a new one). */
  abstract refresh(tokens: ClaudeTokens): Promise<ClaudeTokens>;
}

/** The Claude session: the active account's tokens with at least the expiry buffer left (core OAuthSessionPort). */
export type ClaudeSessionPort = OAuthSessionPort<ClaudeTokens>;

export abstract class ClaudeIdentityPort {
  /** Persistent device id (official CLI format: 32 random bytes as 64 lowercase hex characters). */
  abstract deviceId(): Promise<string>;
  /** One session id per proxy process (the source uses one per relay start). */
  abstract readonly sessionId: string;
  abstract previousMessageId(): string | null;
  abstract setPreviousMessageId(id: string): void;
}

export type CatalogListing = { readonly source: ModelsSource; readonly entries: readonly CatalogModelEntry[] };

export abstract class ClaudeCatalogPort {
  /** Live catalog (24 h cache), else stale cache, else the static minimum, with where it came from. Never empty. */
  abstract listing(): Promise<CatalogListing>;

  async entries(): Promise<readonly CatalogModelEntry[]> {
    return (await this.listing()).entries;
  }
}
