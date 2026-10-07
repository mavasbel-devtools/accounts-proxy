// Provider-internal abstractions. ClaudeSubscriptionProvider depends only on these; the adapters in
// adapters/outbound implement them and composition wires them.
import { OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import type { ClaudeTokens } from "../../domain/credential.ts";
import type { CatalogModelEntry } from "../../domain/model-envelope.ts";

export abstract class ClaudeOAuthPort extends OAuthClientPort {
  /** Rotate the access token (and the refresh token when the server issues a new one). */
  abstract refresh(tokens: ClaudeTokens): Promise<ClaudeTokens>;
}

export abstract class ClaudeSessionPort {
  /** Tokens of the active account with at least the expiry buffer left; refreshes (single-flight, locked) when needed. */
  abstract freshTokens(): Promise<ClaudeTokens>;
}

export abstract class ClaudeIdentityPort {
  /** Persistent device id (official CLI format: 32 random bytes as 64 lowercase hex characters). */
  abstract deviceId(): Promise<string>;
  /** One session id per router process (the source uses one per relay start). */
  abstract readonly sessionId: string;
  abstract previousMessageId(): string | null;
  abstract setPreviousMessageId(id: string): void;
}

export abstract class ClaudeCatalogPort {
  /** Live catalog (24 h cache), else stale cache, else the static minimum. Never empty. */
  abstract entries(): Promise<readonly CatalogModelEntry[]>;
}
