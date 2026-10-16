// Provider-internal abstractions. OpenAIProvider and the OAuth client depend only on these; the adapters in
// adapters/outbound implement them and composition wires them.
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";
import { OAuthClientPort } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { OAuthSessionPort } from "@accounts-proxy/core/ports/outbound/session.ts";
import type { CatalogEntry } from "@accounts-proxy/provider-openai/domain/catalog.ts";
import type { OpenAITokens } from "@accounts-proxy/provider-openai/domain/credential.ts";
import type { ExpectedClaims, VerifiedIdentity } from "@accounts-proxy/provider-openai/domain/id-token.ts";

export abstract class OpenAIOAuthPort extends OAuthClientPort {
  /** One refresh-token grant (T2); the refresh token rotates (T3). */
  abstract refresh(tokens: OpenAITokens): Promise<OpenAITokens>;
}

/** The OpenAI session: the active registration's tokens with at least the expiry buffer left. */
export type OpenAISessionPort = OAuthSessionPort<OpenAITokens>;

export abstract class IdTokenVerifierPort {
  /** S12: signature against the published JWKS, then the claims; the verified identity. */
  abstract verify(idToken: string, expected: ExpectedClaims): Promise<VerifiedIdentity>;
}

export abstract class OpenAIIdentityPort {
  /** S4: this host's stable `ext_agent_host_id` (`urn:uuid:<UUIDv4>`), created and stored before the first sign-in. */
  abstract hostId(): Promise<string>;
  /** One session id per proxy process, sent as `session-id` when the client sends none (I5). */
  abstract readonly sessionId: string;
}

export type CatalogListing = { readonly source: ModelsSource; readonly entries: readonly CatalogEntry[] };

export abstract class OpenAICatalogPort {
  /** Live list (24 h cache per registration), else the stored copy, else the built-in list. Never empty. */
  abstract listing(): Promise<CatalogListing>;
}
