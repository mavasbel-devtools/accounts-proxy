// Antigravity account in the router's own pool (AccountCredential.data). Fields mirror opencode-antigravity-auth
// @ 5c6f7c2 domain/entities/Account.ts; enable/cooldown are dropped because the router never rotates accounts
// automatically (plan D4) — the active account is chosen only by `inference-router account use`.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { JsonObject } from "@inference-router/core/domain/json.ts";
import { EXPIRY_BUFFER_MS } from "@inference-router/provider-antigravity/domain/constants.ts";

export type AuthTokens = { readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number };

export type AntigravityAccount = {
  readonly email: string;
  readonly tokens: AuthTokens;
  readonly projectIds: readonly string[];
  readonly activeProjectId?: string;
};

export function isExpired(tokens: AuthTokens, now: number): boolean {
  return tokens.expiresAt - now <= EXPIRY_BUFFER_MS;
}

/** Source pickActiveProject. */
export function activeProject(account: AntigravityAccount): string | undefined {
  return account.activeProjectId ?? account.projectIds[0];
}

/** A rotated token set keeps the previous refresh token when the server does not issue a new one (source ensureFresh). */
export function rotated(previous: AuthTokens, fresh: AuthTokens): AuthTokens {
  const refreshToken = fresh.refreshToken ?? previous.refreshToken;
  return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt, ...(refreshToken !== undefined ? { refreshToken } : {}) };
}

export function toCredential(account: AntigravityAccount, id: string): AccountCredential {
  const tokens: JsonObject = { accessToken: account.tokens.accessToken, expiresAt: account.tokens.expiresAt };
  if (account.tokens.refreshToken !== undefined) tokens.refreshToken = account.tokens.refreshToken;
  const data: JsonObject = { email: account.email, tokens, projectIds: [...account.projectIds] };
  if (account.activeProjectId !== undefined) data.activeProjectId = account.activeProjectId;
  return { provider: "antigravity", id, label: account.email !== "" ? account.email : id, data };
}

export function fromCredential(credential: AccountCredential): AntigravityAccount | undefined {
  const d = credential.data;
  const t = d.tokens;
  if (typeof d.email !== "string" || typeof t !== "object" || t === null || Array.isArray(t)) return undefined;
  if (typeof t.accessToken !== "string" || typeof t.expiresAt !== "number") return undefined;
  if (!Array.isArray(d.projectIds) || !d.projectIds.every((p) => typeof p === "string")) return undefined;
  return {
    email: d.email,
    tokens: { accessToken: t.accessToken, expiresAt: t.expiresAt, ...(typeof t.refreshToken === "string" ? { refreshToken: t.refreshToken } : {}) },
    projectIds: d.projectIds as string[],
    ...(typeof d.activeProjectId === "string" ? { activeProjectId: d.activeProjectId } : {}),
  };
}

/** Same Google account ⇒ same identity (source LoginUseCase): the pool id is the e-mail, else a minted id. */
export function accountId(account: AntigravityAccount, mint: () => string): string {
  return account.email !== "" ? account.email : `antigravity-${mint()}`;
}
