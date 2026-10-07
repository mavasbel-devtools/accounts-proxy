// Provider accounts held by the router (own store, never shared with Claude Code or the plugins).
import { UnknownAccountError } from "@inference-router/core/domain/errors.ts";
import type { JsonObject } from "@inference-router/core/domain/json.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";

export type AccountCredential = {
  readonly provider: ProviderId;
  /** Stable identity, e.g. the account e-mail. */
  readonly id: string;
  readonly label: string;
  /** Provider-specific credential payload (tokens, expiry, project ids …), owned by the provider adapter. */
  readonly data: JsonObject;
};

export type AccountPool = {
  readonly accounts: readonly AccountCredential[];
  readonly activeId?: string;
};

export const EMPTY_POOL: AccountPool = { accounts: [] };

/** Insert or replace by id, and make it the active account (a fresh login is the user's explicit choice). */
export function upsertAccount(pool: AccountPool, account: AccountCredential): AccountPool {
  const others = pool.accounts.filter((a) => a.id !== account.id);
  return { accounts: [...others, account], activeId: account.id };
}

export function useAccount(pool: AccountPool, provider: ProviderId, id: string): AccountPool {
  if (!pool.accounts.some((a) => a.id === id)) throw new UnknownAccountError(provider, id);
  return { accounts: pool.accounts, activeId: id };
}

export function activeAccount(pool: AccountPool): AccountCredential | undefined {
  return pool.accounts.find((a) => a.id === pool.activeId);
}

export function replaceAccount(pool: AccountPool, account: AccountCredential): AccountPool {
  return { ...pool, accounts: pool.accounts.map((a) => (a.id === account.id ? account : a)) };
}
