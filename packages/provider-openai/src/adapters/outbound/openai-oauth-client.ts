// Sign in with ChatGPT (plan usage): rules S1–S16 and T2–T4 of docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md.
// Authorize parameters and order, exchange and refresh bodies: chatgpt.ts @ 35ef229454 (authorizeURL, exchange,
// refresh), with `agent_name_hint` = accounts-proxy (O4). A login re-authorizes the active registration with its
// issued client id; `--new` (AuthorizeInput.fresh) or no registration yet registers a new one through
// `dynamic_agent_client`, whose callback carries the issued client id (S2, S9).
import { activeAccount, TOKEN_ENDPOINT_TIMEOUT_MS, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { AuthorizeInput, ExchangeInput } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { ClockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { AGENT_NAME, AUTHORIZE_PATH, CALLBACK_PATH, REGISTRATION_CLIENT_ID, RESOURCE, SCOPES, TOKEN_PATH, USER_AGENT } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { fromAccount, grantedTokens, grantsPlanUsage, refreshed, toAccount, type OpenAITokens, type TokenEndpointResponse } from "@accounts-proxy/provider-openai/domain/credential.ts";
import { OpenAIOAuthPort, type IdTokenVerifierPort, type OpenAIIdentityPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

const PROVIDER = "openai";
const TOKEN_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT };

/** A started authorization: the registration it re-authorizes (if any), kept until its callback is exchanged (S9). */
type Pending = { readonly previous: OpenAITokens | undefined };

export class OpenAIOAuthClient extends OpenAIOAuthPort {
  readonly provider = PROVIDER;
  readonly callbackPath = CALLBACK_PATH;
  readonly manualRedirectUri = undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly store: CredentialStorePort,
    private readonly identity: OpenAIIdentityPort,
    private readonly verifier: IdTokenVerifierPort,
    private readonly clock: ClockPort,
    private readonly authOrigin: string,
  ) {
    super();
  }

  /** S5: `http://127.0.0.1:<port>/auth/callback`, never `localhost`. */
  override redirectUri(port: number): string {
    return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  async authorizeUrl(input: AuthorizeInput): Promise<string> {
    const host = await this.identity.hostId();
    const active = input.fresh ? undefined : activeAccount(await this.store.load(PROVIDER));
    const previous = active === undefined ? undefined : fromAccount(active);
    this.pending.set(input.state, { previous });
    const q = new URLSearchParams();
    q.append("client_id", previous?.clientId ?? REGISTRATION_CLIENT_ID);
    if (previous === undefined) q.append("agent_name_hint", AGENT_NAME);
    q.append("ext_agent_host_id", host);
    q.append("response_type", "code");
    q.append("redirect_uri", input.redirectUri);
    q.append("scope", SCOPES);
    q.append("resource", RESOURCE);
    q.append("state", input.state);
    q.append("nonce", input.nonce);
    q.append("code_challenge_method", "S256");
    q.append("code_challenge", input.codeChallenge);
    return `${this.authOrigin}${AUTHORIZE_PATH}?${q.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    // The login service exchanges only the state it started (an unknown one is refused before the exchange); a missing
    // entry is therefore never a registration to re-authorize, and a new one still needs its issued client id below.
    const previous = this.pending.get(input.state)?.previous;
    this.pending.delete(input.state);
    const returned = input.callback["client_id"];
    const saved = previous?.clientId;
    if (saved !== undefined && returned !== undefined && returned !== saved) {
      throw new ProviderAuthRequiredError(PROVIDER, "ChatGPT returned a different client than this registration; sign in again");
    }
    const clientId = saved ?? returned;
    if (clientId === undefined || clientId === "" || clientId === REGISTRATION_CLIENT_ID) {
      throw new ProviderAuthRequiredError(PROVIDER, "ChatGPT sign-in did not return an issued client id (registration incomplete); sign in again");
    }
    const granted = grantedTokens(
      await this.post({ grant_type: "authorization_code", client_id: clientId, code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri, resource: RESOURCE }),
      this.clock.now(),
    );
    const scopes = granted.scopes ?? "";
    if (!grantsPlanUsage(scopes)) {
      throw new ProviderAuthRequiredError(PROVIDER, "the sign-in did not grant ChatGPT plan usage (chatgpt.tokens.use.direct); sign in again and allow it");
    }
    if (granted.idToken === undefined) throw new ProviderAuthRequiredError(PROVIDER, "ChatGPT sign-in did not return an ID token");
    const identity = await this.verifier.verify(granted.idToken, { clientId, nonce: input.nonce, now: this.clock.now() });
    if (previous !== undefined && previous.subject !== identity.subject) {
      throw new ProviderAuthRequiredError(PROVIDER, "the sign-in returned a different ChatGPT account than this registration; use `login openai --new` to add it");
    }
    return toAccount({
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresAt: granted.expiresAt,
      scopes,
      clientId,
      subject: identity.subject,
      idToken: granted.idToken,
      ...(identity.email !== undefined ? { email: identity.email } : {}),
    });
  }

  successRedirect(): undefined {
    return undefined;
  }

  async refresh(tokens: OpenAITokens): Promise<OpenAITokens> {
    const response = await this.post({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refreshToken, resource: RESOURCE });
    return refreshed(tokens, grantedTokens(response, this.clock.now()));
  }

  /** 400/401 reject the grant (T4: a new login is needed); other failures are upstream errors. Bounded by 30 s (H-c). */
  private async post(body: Record<string, string>): Promise<TokenEndpointResponse> {
    const res = await this.transport.send({
      method: "POST",
      url: `${this.authOrigin}${TOKEN_PATH}`,
      headers: TOKEN_HEADERS,
      body: new URLSearchParams(body).toString(),
      timeoutMs: TOKEN_ENDPOINT_TIMEOUT_MS,
    });
    const text = await readAll(res.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.status === 400 || res.status === 401) {
      const code = isJsonObject(parsed) && typeof parsed["error"] === "string" ? ` ${parsed["error"]}` : "";
      throw new ProviderAuthRequiredError(PROVIDER, `token endpoint rejected the grant (HTTP ${res.status}${code})`);
    }
    if (res.status < 200 || res.status >= 300) throw new UpstreamError(PROVIDER, res.status, text);
    if (!isJsonObject(parsed)) throw new UpstreamError(PROVIDER, 502, `token endpoint returned non-JSON: ${text}`);
    return parsed as TokenEndpointResponse;
  }
}
