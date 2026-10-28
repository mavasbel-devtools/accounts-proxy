// Provider accounts held by the proxy (own store, never shared with Claude Code or the plugins).
import { UnknownAccountError } from "@accounts-proxy/core/domain/errors.ts";
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

export type AccountCredential = {
  readonly provider: ProviderId;
  /** Stable identity, e.g. the account e-mail. */
  readonly id: string;
  readonly label: string;
  /** Provider-specific credential payload (tokens, expiry, project ids …), owned by the provider adapter. */
  readonly data: JsonObject;
  /**
   * Set when the provider's token endpoint rejected the refresh grant (plan v4 H6): requests fail fast with
   * provider_auth_required instead of calling the token endpoint again. A new login replaces the account and clears it.
   */
  readonly needsLogin?: string;
};

export type AccountPool = {
  readonly accounts: readonly AccountCredential[];
  readonly activeId?: string;
};

/**
 * Deadline of one token-endpoint exchange (plan v4 H2/H-c). A renewal runs inside the cross-process renewal lock, and a
 * lock older than its staleness (60 s, apps/proxy file-lock.ts DEFAULT_LOCK_OPTIONS.staleMs) is taken over by another
 * process; the deadline must stay below that, or two processes could spend the same refresh token. Design value.
 */
export const TOKEN_ENDPOINT_TIMEOUT_MS = 30_000;

/**
 * After a transient renewal failure the stored, still valid token is used without a new renewal attempt for this long
 * (plan v4 H4), so a failing or hanging token endpoint is not called (and waited for) by every request inside the
 * expiry buffer. Design value.
 */
export const RENEWAL_RETRY_AFTER_MS = 30_000;

export const EMPTY_POOL: AccountPool = { accounts: [] };

/**
 * Providers that use another provider's accounts (plan P4.6 amendment A, decision K2): one OpenCode Console sign-in or
 * key serves both `opencode` and `opencode-go`, so Go's accounts are the ones stored for `opencode`.
 */
const ACCOUNT_OWNER: Readonly<Partial<Record<ProviderId, ProviderId>>> = { "opencode-go": "opencode" };

/** The provider whose account store `provider` uses. */
export function accountOwner(provider: ProviderId): ProviderId {
  return ACCOUNT_OWNER[provider] ?? provider;
}

/** Insert or replace by id, and make it the active account (a fresh login is the user's explicit choice). */
export function upsertAccount(pool: AccountPool, account: AccountCredential): AccountPool {
  const others = pool.accounts.filter((a) => a.id !== account.id);
  return { accounts: [...others, account], activeId: account.id };
}

export function useAccount(pool: AccountPool, provider: ProviderId, id: string): AccountPool {
  if (!pool.accounts.some((a) => a.id === id)) throw new UnknownAccountError(provider, id);
  return { accounts: pool.accounts, activeId: id };
}

/**
 * Delete a stored account (plan 2026-10-26 A1). When it was the active one no account is active afterwards: the proxy
 * never picks another by itself.
 */
export function removeAccount(pool: AccountPool, provider: ProviderId, id: string): AccountPool {
  if (!pool.accounts.some((a) => a.id === id)) throw new UnknownAccountError(provider, id);
  const accounts = pool.accounts.filter((a) => a.id !== id);
  return pool.activeId !== undefined && pool.activeId !== id ? { accounts, activeId: pool.activeId } : { accounts };
}

export function activeAccount(pool: AccountPool): AccountCredential | undefined {
  return pool.accounts.find((a) => a.id === pool.activeId);
}

export function replaceAccount(pool: AccountPool, account: AccountCredential): AccountPool {
  return { ...pool, accounts: pool.accounts.map((a) => (a.id === account.id ? account : a)) };
}

/** Mark one stored account as needing a new login (H6). */
export function markNeedsLogin(pool: AccountPool, account: AccountCredential, reason: string): AccountPool {
  return replaceAccount(pool, { ...account, needsLogin: reason });
}
