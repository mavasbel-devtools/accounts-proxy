// Google OAuth for Antigravity: browser login with an RFC 8252 loopback redirect, plus refresh.
// Port of opencode-antigravity-auth @ 5c6f7c2 GoogleOAuthClientAdapter.ts (authorize parameters and order, token form)
// and LoginUseCase.buildAccount (userinfo → loadCodeAssist → onboardUser bootstrap). The source uses no PKCE, so
// none is added (an unmeasured wire change).
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { AuthorizeInput, ExchangeInput } from "@inference-router/core/ports/outbound/oauth.ts";
import type { ClockPort, LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { accountId, toCredential, type AntigravityAccount, type AuthTokens } from "@inference-router/provider-antigravity/domain/account.ts";
import { AUTHORIZE_URL, CLIENT_ID, CLIENT_SECRET, DEFAULT_EXPIRES_IN_S, LOOPBACK_CALLBACK_PATH, SCOPES, SUCCESS_REDIRECT, TOKEN_URL } from "@inference-router/provider-antigravity/domain/constants.ts";
import { extractProjectIds, onboardedProjectId } from "@inference-router/provider-antigravity/domain/project.ts";
import { AntigravityOAuthPort, type AntigravityApiPort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export type GoogleOAuthEndpoints = { readonly authorizeUrl: string; readonly tokenUrl: string };
export const PRODUCTION_ENDPOINTS: GoogleOAuthEndpoints = { authorizeUrl: AUTHORIZE_URL, tokenUrl: TOKEN_URL };

export class GoogleOAuthClient extends AntigravityOAuthPort {
  readonly provider = "antigravity";
  readonly callbackPath = LOOPBACK_CALLBACK_PATH;
  readonly usesPkce = false;
  readonly manualRedirectUri = undefined;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly api: AntigravityApiPort,
    private readonly clock: ClockPort,
    private readonly random: RandomPort,
    private readonly logger: LoggerPort,
    private readonly endpoints: GoogleOAuthEndpoints,
  ) {
    super();
  }

  authorizeUrl(input: AuthorizeInput): string {
    const params = new URLSearchParams({
      access_type: "offline",
      scope: SCOPES.join(" "),
      state: input.state,
      prompt: "consent",
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: input.redirectUri,
    });
    return `${this.endpoints.authorizeUrl}?${params.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    const tokens = await this.token({
      grant_type: "authorization_code",
      code: input.code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: input.redirectUri,
    });
    const account = await this.bootstrap(tokens);
    return toCredential(account, accountId(account, () => this.random.uuid()));
  }

  successRedirect(): string {
    return SUCCESS_REDIRECT;
  }

  async refresh(tokens: AuthTokens): Promise<AuthTokens> {
    if (tokens.refreshToken === undefined) throw new ProviderAuthRequiredError("antigravity", "access token expired and no refresh token is stored");
    const fresh = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    return { ...fresh, ...(fresh.refreshToken === undefined ? { refreshToken: tokens.refreshToken } : {}) };
  }

  /** Source LoginUseCase.buildAccount: each step is best-effort except onboarding, which runs only without a project. */
  private async bootstrap(tokens: AuthTokens): Promise<AntigravityAccount> {
    let email = "";
    try {
      email = (await this.api.fetchUserInfo(tokens)).email ?? "";
    } catch (error) {
      this.logger.warn(`antigravity: fetchUserInfo failed (${String(error)})`);
    }
    let projectIds: string[] = [];
    try {
      projectIds = extractProjectIds(await this.api.loadCodeAssist(tokens));
    } catch (error) {
      this.logger.warn(`antigravity: loadCodeAssist failed (${String(error)})`);
    }
    if (projectIds.length === 0) {
      const onboarded = onboardedProjectId(await this.api.onboardUser(tokens));
      if (onboarded.length > 0) projectIds = [onboarded];
    }
    return { email, tokens, projectIds, ...(projectIds[0] !== undefined ? { activeProjectId: projectIds[0] } : {}) };
  }

  /** 400/401 (RFC 6749 §5.2) mean the grant is no longer valid; other failures are upstream errors. */
  private async token(form: Record<string, string>): Promise<AuthTokens> {
    const res = await this.transport.send({
      method: "POST",
      url: this.endpoints.tokenUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const text = await readAll(res.body);
    if (res.status === 400 || res.status === 401) throw new ProviderAuthRequiredError("antigravity", `token endpoint rejected the grant (HTTP ${res.status})`);
    if (res.status < 200 || res.status >= 300) throw new UpstreamError("antigravity", res.status, text);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // fall through to the access_token check, as the source does
    }
    const accessToken = json["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) throw new UpstreamError("antigravity", 502, "token response missing access_token");
    const expiresIn = typeof json["expires_in"] === "number" ? json["expires_in"] : Number(json["expires_in"] ?? DEFAULT_EXPIRES_IN_S);
    const refreshToken = json["refresh_token"];
    return {
      accessToken,
      expiresAt: this.clock.now() + expiresIn * 1000,
      ...(typeof refreshToken === "string" && refreshToken !== "" ? { refreshToken } : {}),
    };
  }
}
