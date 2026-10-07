/**
 * OAuth subscription credential, matching the shared store that the real
 * `claude` CLI reads/writes (`~/.claude/.credentials.json`, key
 * `claudeAiOauth`) and the opencode host mirror under the provider id.
 */
export interface ClaudeOAuthCredential {
  readonly accessToken: string
  readonly refreshToken?: string
  /** epoch ms at which the access token expires. */
  readonly expiresAt: number
  /** granted scope set, space-separated (sent back verbatim on refresh). */
  readonly scopes: string
  readonly subscriptionType?: string
  readonly rateLimitTier?: string
  /** OAuth account uuid — feeds `metadata.user_id.account_uuid` on the wire. */
  readonly accountUuid?: string
  readonly organizationUuid?: string
  readonly accountEmail?: string
}

/** Result of a token endpoint call (exchange or refresh). */
export interface TokenEndpointResult {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresIn: number
  readonly scope: string
  readonly tokenUuid: string
  readonly refreshTokenExpiresIn?: number
  readonly organization?: { readonly uuid: string; readonly name: string }
  readonly account?: { readonly uuid: string; readonly emailAddress: string }
}

export function credentialExpired(cred: ClaudeOAuthCredential, now: number, bufferMs = 120_000): boolean {
  return cred.expiresAt - now <= bufferMs
}