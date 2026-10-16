// Anthropic OAuth client: browser (loopback) login + token refresh.
// Authorize parameters and order: official Claude Code 2.1.280 `_Ln`; exchange body: `M_r`; success redirect:
// `handleSuccessRedirect` (P0-E6). Token request headers and refresh body: opencode-claude-auth @ 6292741
// ClaudeOAuthClientAdapter (captured fixtures refresh-request.json / refresh-request-headers.json).
import { TOKEN_ENDPOINT_TIMEOUT_MS, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { AuthorizeInput, ExchangeInput } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { ClockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import {
  AUTHORIZE_SCOPES,
  AUTHORIZE_URL,
  CLAUDEAI_SUCCESS_URL,
  CLIENT_ID,
  CONSOLE_SUCCESS_URL,
  INFERENCE_SCOPE,
  LOOPBACK_CALLBACK_PATH,
  MANUAL_REDIRECT_URI,
  REFRESH_SCOPES,
  TOKEN_HEADERS,
  TOKEN_URL,
} from "@accounts-proxy/provider-claude/domain/constants.ts";
import { fromAccount, hasScope, toAccount, tokensFromResponse, type ClaudeTokens, type TokenEndpointResponse } from "@accounts-proxy/provider-claude/domain/credential.ts";
import { ClaudeOAuthPort } from "@accounts-proxy/provider-claude/ports/outbound/claude.ts";

export type ClaudeOAuthEndpoints = { readonly authorizeUrl: string; readonly tokenUrl: string };
export const PRODUCTION_ENDPOINTS: ClaudeOAuthEndpoints = { authorizeUrl: AUTHORIZE_URL, tokenUrl: TOKEN_URL };

export class ClaudeOAuthClient extends ClaudeOAuthPort {
  readonly provider = "claude";
  readonly callbackPath = LOOPBACK_CALLBACK_PATH;
  readonly manualRedirectUri = MANUAL_REDIRECT_URI;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly clock: ClockPort,
    private readonly endpoints: ClaudeOAuthEndpoints,
  ) {
    super();
  }

  async authorizeUrl(input: AuthorizeInput): Promise<string> {
    const q = new URLSearchParams();
    q.append("code", "true");
    q.append("client_id", CLIENT_ID);
    q.append("response_type", "code");
    q.append("redirect_uri", input.redirectUri);
    q.append("scope", AUTHORIZE_SCOPES.join(" "));
    q.append("code_challenge", input.codeChallenge);
    q.append("code_challenge_method", "S256");
    q.append("state", input.state);
    return `${this.endpoints.authorizeUrl}?${q.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    const response = await this.post({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: input.codeVerifier,
      state: input.state,
    });
    return toAccount(tokensFromResponse(response, this.clock.now()));
  }

  successRedirect(account: AccountCredential): string {
    const tokens = fromAccount(account);
    return tokens !== undefined && hasScope(tokens, INFERENCE_SCOPE) ? CLAUDEAI_SUCCESS_URL : CONSOLE_SUCCESS_URL;
  }

  async refresh(tokens: ClaudeTokens): Promise<ClaudeTokens> {
    if (tokens.refreshToken === undefined) throw new ProviderAuthRequiredError(this.provider, "access token expired and no refresh token is stored");
    const response = await this.post({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
      scope: tokens.scopes !== "" ? tokens.scopes : REFRESH_SCOPES.join(" "),
    });
    return tokensFromResponse(response, this.clock.now(), tokens);
  }

  /**
   * 400/401 (RFC 6749 §5.2 invalid_grant / invalid_client) mean the login is no longer valid; other failures are upstream
   * errors. The exchange is bounded by TOKEN_ENDPOINT_TIMEOUT_MS (plan v4 H-c).
   */
  private async post(body: Record<string, string>): Promise<TokenEndpointResponse> {
    const res = await this.transport.send({ method: "POST", url: this.endpoints.tokenUrl, headers: TOKEN_HEADERS, body: JSON.stringify(body), timeoutMs: TOKEN_ENDPOINT_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status === 400 || res.status === 401) {
      throw new ProviderAuthRequiredError(this.provider, `token endpoint rejected the grant (HTTP ${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) throw new UpstreamError(this.provider, res.status, text);
    try {
      return JSON.parse(text) as TokenEndpointResponse;
    } catch {
      throw new UpstreamError(this.provider, 502, `token endpoint returned non-JSON: ${text}`);
    }
  }
}
