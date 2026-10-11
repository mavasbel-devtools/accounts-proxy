// Claude OAuth credential held in the router's own account pool (AccountCredential.data).
// Fields mirror opencode-claude-auth @ 6292741 ClaudeOAuthCredential + TokenEndpointResult.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { isJsonObject, type JsonObject } from "@inference-router/core/domain/json.ts";
import { EXPIRY_BUFFER_MS } from "@inference-router/provider-claude/domain/constants.ts";

export type ClaudeTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms at which the access token expires. */
  readonly expiresAt: number;
  /** Granted scope string, sent back verbatim on refresh (source behaviour). */
  readonly scopes: string;
  readonly accountUuid?: string;
  readonly organizationUuid?: string;
  readonly email?: string;
};

/** Raw `POST /v1/oauth/token` response (fields as captured in fixture refresh-response.json). */
export type TokenEndpointResponse = {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token?: unknown;
  readonly scope?: unknown;
  readonly account?: { readonly uuid?: unknown; readonly email_address?: unknown };
  readonly organization?: { readonly uuid?: unknown };
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Build tokens from a token-endpoint response. A rotated refresh token replaces the previous one; when the
 * response omits it, the previous one is kept (OAuth 2.0 RFC 6749 §6: the server MAY issue a new refresh token).
 * Account identity absent from the response is kept from `previous`.
 */
export function tokensFromResponse(response: TokenEndpointResponse, now: number, previous?: ClaudeTokens): ClaudeTokens {
  const accessToken = str(response.access_token);
  const expiresIn = response.expires_in;
  if (accessToken === undefined || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new Error("token endpoint response lacks access_token/expires_in");
  }
  const refreshToken = str(response.refresh_token) ?? previous?.refreshToken;
  const accountUuid = str(response.account?.uuid) ?? previous?.accountUuid;
  const organizationUuid = str(response.organization?.uuid) ?? previous?.organizationUuid;
  const email = str(response.account?.email_address) ?? previous?.email;
  return {
    accessToken,
    expiresAt: now + expiresIn * 1000,
    scopes: str(response.scope) ?? previous?.scopes ?? "",
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(accountUuid !== undefined ? { accountUuid } : {}),
    ...(organizationUuid !== undefined ? { organizationUuid } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

export function isExpired(tokens: ClaudeTokens, now: number): boolean {
  return tokens.expiresAt - now <= EXPIRY_BUFFER_MS;
}

export function hasScope(tokens: ClaudeTokens, scope: string): boolean {
  return tokens.scopes.split(/\s+/).includes(scope);
}

export function toAccount(tokens: ClaudeTokens): AccountCredential {
  const id = tokens.email ?? tokens.accountUuid ?? "claude-account";
  const data: JsonObject = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes };
  if (tokens.refreshToken !== undefined) data.refreshToken = tokens.refreshToken;
  if (tokens.accountUuid !== undefined) data.accountUuid = tokens.accountUuid;
  if (tokens.organizationUuid !== undefined) data.organizationUuid = tokens.organizationUuid;
  if (tokens.email !== undefined) data.email = tokens.email;
  return { provider: "claude", id, label: id, data };
}

/** Read tokens back from a stored account; undefined when the stored shape is not a Claude credential. */
export function fromAccount(account: AccountCredential): ClaudeTokens | undefined {
  const d = account.data;
  if (!isJsonObject(d) || typeof d.accessToken !== "string" || typeof d.expiresAt !== "number" || typeof d.scopes !== "string") return undefined;
  return {
    accessToken: d.accessToken,
    expiresAt: d.expiresAt,
    scopes: d.scopes,
    ...(typeof d.refreshToken === "string" ? { refreshToken: d.refreshToken } : {}),
    ...(typeof d.accountUuid === "string" ? { accountUuid: d.accountUuid } : {}),
    ...(typeof d.organizationUuid === "string" ? { organizationUuid: d.organizationUuid } : {}),
    ...(typeof d.email === "string" ? { email: d.email } : {}),
  };
}
