// OpenRouter browser login (rules R5–R7): PKCE S256 on the OpenRouter page with a localhost callback, or the headless
// page that shows the code (`--manual`); the code is exchanged for an API key. The key never expires, so the account is
// an API-key account (plan P4.6 §2 item 3) used through GatewayKeySession.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { apiKeyAccount, keyAccountId, normalizeApiKey } from "@inference-router/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import { TOKEN_ENDPOINT_TIMEOUT_MS } from "@inference-router/core/domain/accounts.ts";
import { parseJsonBody } from "@inference-router/core/domain/services/json-body.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import { OAuthClientPort, type AuthorizeInput, type ExchangeInput } from "@inference-router/core/ports/outbound/oauth.ts";
import type { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { firstString } from "@inference-router/provider-gateway/domain/gateway.ts";
import { authorizeUrl, CALLBACK_PATH, HEADLESS_REDIRECT, KEYS_PATH, parseKeyExchange } from "@inference-router/provider-openrouter/domain/openrouter.ts";

export class OpenRouterOAuthClient extends OAuthClientPort {
  readonly provider = "openrouter";
  readonly callbackPath = CALLBACK_PATH;
  readonly manualRedirectUri = HEADLESS_REDIRECT;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly hash: HashPort,
    private readonly authUrl: string,
    private readonly apiBase: string,
  ) {
    super();
  }

  async authorizeUrl(input: AuthorizeInput): Promise<string> {
    return authorizeUrl(this.authUrl, input.redirectUri, input.state, input.codeChallenge);
  }

  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    const res = await this.transport.send({
      method: "POST",
      url: `${this.apiBase}${KEYS_PATH}`,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: input.code, code_verifier: input.codeVerifier, code_challenge_method: "S256" }),
      timeoutMs: TOKEN_ENDPOINT_TIMEOUT_MS,
    });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new ProviderAuthRequiredError(this.provider, `key exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    const answer = parseKeyExchange(parseJsonBody(text));
    const key = normalizeApiKey(this.provider, answer.key);
    const id = firstString(answer.userId, keyAccountId(this.hash.sha256(key)))!;
    return apiKeyAccount(this.provider, id, id, key);
  }

  successRedirect(): string | undefined {
    return undefined;
  }
}
