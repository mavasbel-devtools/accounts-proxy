import type { ClaudeOAuthCredential, TokenEndpointResult } from '@claude/domain/entities/ClaudeCredential.ts'
import type { CatalogModelEntry } from '@claude/domain/services/ModelEnvelope.ts'

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
}

/**
 * Outbound port: the Anthropic OAuth endpoints (paste-code flow).
 * Contract captured from real `claude auth login` + ground-truth SDK ports.
 */
export interface OAuthClientPort {
  /** The `claude.com/cai/oauth/authorize` URL (code=true, PKCE S256, 32B state). */
  buildAuthUrl(state: string, codeChallenge: string): string
  /** Exchanges the pasted code at `platform.claude.com/v1/oauth/token`. */
  exchangeCode(params: { code: string; codeVerifier: string; state: string }): Promise<TokenEndpointResult>
  /** Rotates the session; the refresh body includes the granted scope (captured). */
  refresh(refreshToken: string, scope: string): Promise<TokenEndpointResult>
}

export interface CallbackResult {
  readonly code: string
  readonly state: string
}

export interface ClockPort {
  now(): number
}

export interface RandomPort {
  uuid(): string
  /** base64url 32 random bytes — the OAuth `state`/verifier. */
  bytes32Base64Url(): string
  /** base64url SHA-256 of the code verifier — the PKCE challenge. */
  sha256Base64Url(input: string): string
}

export interface LoggerPort {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string, err?: unknown): void
}

/** The shared `claudeAiOauth` credential file (and the opencode host mirror). */
export interface CredentialStorePort {
  load(): Promise<ClaudeOAuthCredential | undefined>
  save(cred: ClaudeOAuthCredential): Promise<void>
}

export interface BrowserLauncherPort {
  open(url: string): Promise<void>
}

/** The raw wire request handed to the relay by the host's anthropic provider. */
export interface AnthropicWireRequest {
  readonly method: string
  /** Full URL (parity transform resolves api.anthropic.com + path + beta=true). */
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** The transformed wire request forwarded to api.anthropic.com. */
export interface AnthropicWireResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

/** Outbound port: the real Anthropic Messages API. */
export interface AnthropicApiClientPort {
  /** Forwards one transformed request and returns the full response (SSE passthrough). */
  forward(request: AnthropicWireRequest): Promise<AnthropicWireResponse>
}

/** Per-relay-session context used to build the claude-parity envelope. */
export interface TransformContext {
  readonly accessToken: string
  readonly accountUuid: string
  readonly deviceId: string
  readonly sessionId: string
  readonly previousMessageId: string | null
}

/** Outbound port: persistent machine/session identity for the wire envelope. */
export interface IdentityStorePort {
  loadDeviceId(): Promise<string>
  newSessionId(): string
  loadPreviousMessageId(): string | null
  setPreviousMessageId(id: string): void
}

/** One entry of the live Anthropic `/v1/models` catalog. */
export type { CatalogModelEntry }

/** Outbound port: the live Anthropic models catalog (`GET /v1/models`). */
export interface ModelCatalogClientPort {
  /** Fetches the full paginated catalog with an OAuth bearer token. */
  fetchCatalog(accessToken: string): Promise<readonly CatalogModelEntry[]>
}

/** Outbound port: persisted catalog cache (survives restarts, offline fallback). */
export interface CatalogCachePort {
  load(): Promise<{ fetchedAt: number; models: readonly CatalogModelEntry[] } | null>
  save(snapshot: { fetchedAt: number; models: readonly CatalogModelEntry[] }): Promise<void>
}