export interface AuthTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  /** epoch ms */
  readonly expiresAt: number
}

export interface Account {
  readonly id: string
  readonly email: string
  readonly tokens: AuthTokens
  readonly projectIds: readonly string[]
  readonly activeProjectId?: string
  readonly enabled: boolean
  /** epoch ms; account skipped for selection while in the future */
  readonly cooldownUntil?: number
}

export interface AccountPoolState {
  readonly accounts: readonly Account[]
  readonly activeAccountId?: string
}
