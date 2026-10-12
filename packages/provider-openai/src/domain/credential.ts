// OpenAI credential record in the router's own account pool (AccountCredential.data). Fields: rules S13–S14 (the
// documented local credential record, openai-siwc-sign-in.md §5) and T1–T5 (token lifetimes and refresh).
// One account per issued client id (a registration): its id is the issued client id, its label the email.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { isJsonObject, type JsonObject } from "@inference-router/core/domain/json.ts";
import { DEFAULT_EXPIRES_IN_S, PLAN_USAGE_SCOPE } from "@inference-router/provider-openai/domain/constants.ts";

export type OpenAITokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms at which the access token expires. */
  readonly expiresAt: number;
  /** Granted scopes (space-separated, as returned). */
  readonly scopes: string;
  /** The issued client id of this registration (never `dynamic_agent_client`). */
  readonly clientId: string;
  /** The verified ID-token subject. */
  readonly subject: string;
  /** Retained for `id_token_hint` on a later sign-in (S15). */
  readonly idToken: string;
  readonly email?: string;
};

/** Raw token-endpoint response (openai-siwc-token-reference.md "Token response"). */
export type TokenEndpointResponse = {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The fields of a token response every grant must carry; the refresh token rotates on every refresh (T3). */
export type GrantedTokens = { readonly accessToken: string; readonly refreshToken: string; readonly idToken?: string; readonly expiresAt: number; readonly scopes?: string };

export function grantedTokens(response: TokenEndpointResponse, now: number): GrantedTokens {
  const accessToken = str(response.access_token);
  const refreshToken = str(response.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) throw new Error("token endpoint response lacks access_token/refresh_token");
  const expiresIn = typeof response.expires_in === "number" && Number.isFinite(response.expires_in) ? response.expires_in : DEFAULT_EXPIRES_IN_S;
  const idToken = str(response.id_token);
  const scopes = typeof response.scope === "string" ? response.scope : undefined;
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, ...(idToken !== undefined ? { idToken } : {}), ...(scopes !== undefined ? { scopes } : {}) };
}

/** S11: the grant enables ChatGPT plan usage only with `chatgpt.tokens.use.direct`. */
export function grantsPlanUsage(scopes: string): boolean {
  return scopes.split(/\s+/).includes(PLAN_USAGE_SCOPE);
}

/**
 * T3: a refresh replaces the access token, expiry, scopes and refresh token together. The identity, and the ID token
 * verified at sign-in, are kept (a refresh response's ID token is not re-verified, so it is not stored).
 */
export function refreshed(previous: OpenAITokens, granted: GrantedTokens): OpenAITokens {
  return { ...previous, accessToken: granted.accessToken, refreshToken: granted.refreshToken, expiresAt: granted.expiresAt, scopes: granted.scopes ?? previous.scopes };
}

export function toAccount(tokens: OpenAITokens): AccountCredential {
  const data: JsonObject = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    clientId: tokens.clientId,
    subject: tokens.subject,
    idToken: tokens.idToken,
  };
  if (tokens.email !== undefined) data.email = tokens.email;
  return { provider: "openai", id: tokens.clientId, label: tokens.email ?? tokens.subject, data };
}

/** Read tokens back from a stored account; undefined when the stored shape is not an OpenAI credential. */
export function fromAccount(account: AccountCredential): OpenAITokens | undefined {
  const d = account.data;
  if (!isJsonObject(d)) return undefined;
  const { accessToken, refreshToken, expiresAt, scopes, clientId, subject, idToken, email } = d;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number" || typeof scopes !== "string") return undefined;
  if (typeof clientId !== "string" || typeof subject !== "string" || typeof idToken !== "string") return undefined;
  return { accessToken, refreshToken, expiresAt, scopes, clientId, subject, idToken, ...(typeof email === "string" ? { email } : {}) };
}
