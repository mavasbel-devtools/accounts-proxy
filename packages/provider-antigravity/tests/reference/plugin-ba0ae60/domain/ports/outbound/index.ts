import type { AccountPoolState } from '@antigravity/domain/entities/Account.ts'
import type { AuthTokens } from '@antigravity/domain/entities/Account.ts'

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
}

export interface OAuthClientPort {
  buildAuthUrl(loopbackPort: number, state: string): string
  exchangeCode(code: string, loopbackPort: number): Promise<TokenSet>
  refresh(refreshToken: string): Promise<TokenSet>
}

export interface CallbackResult {
  readonly code: string
  readonly state: string
}

export interface CallbackServerPort {
  start(): Promise<number>
  waitForCallback(timeoutMs: number): Promise<CallbackResult>
  stop(): Promise<void>
}

export interface BrowserLauncherPort {
  open(url: string): Promise<void>
}

export interface ClockPort {
  now(): number
}

export interface RandomPort {
  uuid(): string
}

export interface LoggerPort {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string, err?: unknown): void
}

/** OAuth credential as persisted by the opencode HOST under our provider id. */
export interface HostOauthMirror {
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly expiresAt?: number
}

export interface CredentialStorePort {
  load(): Promise<AccountPoolState | undefined>
  save(state: AccountPoolState): Promise<void>
  /** Best-effort read of the host-written oauth entry (survives even when the pool was clobbered). */
  readHostOauth(): Promise<HostOauthMirror | undefined>
}

/**
 * Durable store of thoughtSignatures keyed by tool-call id. Upstream REQUIRES
 * the original signature when a functionCall is replayed (400 otherwise,
 * proven live 2026-08-25/2026-09-01); OpenAI clients cannot round-trip it, so
 * the transform caches it — in memory for the live process and here so replays
 * survive host restarts.
 */
export interface SignatureStorePort {
  readAll(): Record<string, string>
  upsert(callId: string, signature: string): void
}

/**
 * Durable store of the per-install device `sessionId` (signed 64-bit, held as its
 * exact decimal STRING — proto int64 → JSON string on the wire) that the Antigravity
 * envelope carries on every stream call. The real IDE's value is byte-identical
 * across days and projects — a per-install device constant — so we persist our own
 * minted value next to the pool file (locked decision 2026-09-26: never the
 * machine-captured literal).
 */
export interface DeviceIdentityStorePort {
  load(): string | undefined
  save(sessionId: string): void
}

export type StreamEnvelope = {
  response?: {
    candidates?: Array<{
      content?: {
        role?: string
        parts?: Array<{
          text?: string
          thought?: boolean
          thoughtSignature?: string
          functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
          functionResponse?: { id?: string; name: string; response?: Record<string, unknown> }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
      thoughtsTokenCount?: number
      /**
       * Prompt tokens served from the upstream prompt cache. Capture-verified
       * present on real traffic (32 of 151 captured IDE responses carry it,
       * 30/63 on claude-sonnet), so a missing field means "no cache hit
       * reported", never "this backend has no cache".
       */
      cachedContentTokenCount?: number
    }
    modelVersion?: string
    responseId?: string
  }
  traceId?: string
  metadata?: Record<string, unknown>
}

export interface GenerateParams {
  readonly project: string
  readonly requestId: string
  readonly body: Record<string, unknown>
  readonly modelWireId: string
}

/** Outbound port: the Antigravity cloud API. */
export interface AntigravityApiClientPort {
  loadCodeAssist(tokens: AuthTokens): Promise<Record<string, unknown>>
  /** Onboards a fresh account; resolves with the assigned/current project id. */
  onboardUser(tokens: AuthTokens): Promise<{ projectId: string }>
  fetchUserInfo(tokens: AuthTokens): Promise<{ email?: string }>
  fetchAvailableModels(tokens: AuthTokens): Promise<Record<string, unknown>>
  retrieveUserQuotaSummary(tokens: AuthTokens): Promise<Record<string, unknown>>
  streamGenerate(params: GenerateParams, tokens: AuthTokens): AsyncIterable<StreamEnvelope>
}
