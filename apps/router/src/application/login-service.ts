// Browser login (plan D10). Default: loopback listener on 127.0.0.1 + system browser + automatic redirect capture.
// Fallback (--manual): the provider's paste-code page, only for providers that have one (Claude, OpenRouter headless).
// API-key providers (plan P4.6 N4): the key is read at a hidden prompt and checked by the provider's login client.
// PKCE (RFC 7636 S256) is used exactly when the provider's client uses it (Claude yes, Google/Antigravity no — both as
// their official clients do, see docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md).
import { upsertAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { InvalidRequestError, ProviderDisabledError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { base64UrlEncode } from "@inference-router/core/domain/services/base64url.ts";
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import { codeFromCallback, codeFromManualInput } from "@inference-router/core/domain/services/oauth-flow.ts";
import { LoginPort, type AccountSummary, type LoginOptions } from "@inference-router/core/ports/inbound/accounts.ts";
import type { ApiKeyLoginPort, SecretPromptPort } from "@inference-router/core/ports/outbound/api-key.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { CallbackServerFactoryPort, ManualCodePort, OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import type { BrowserLauncherPort, HashPort, LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";

type Attempt = { readonly state: string; readonly nonce: string; readonly verifier: string; readonly challenge: string; readonly fresh: boolean };

export class LoginService extends LoginPort {
  constructor(
    private readonly clients: readonly OAuthClientPort[],
    private readonly servers: CallbackServerFactoryPort,
    private readonly browser: BrowserLauncherPort,
    private readonly manual: ManualCodePort,
    private readonly store: CredentialStorePort,
    private readonly random: RandomPort,
    private readonly hash: HashPort,
    private readonly logger: LoggerPort,
    private readonly keyClients: readonly ApiKeyLoginPort[],
    private readonly secrets: SecretPromptPort,
  ) {
    super();
  }

  async login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary> {
    const account = await this.signIn(provider, options);
    await this.store.update(provider, (pool) => upsertAccount(pool, account));
    this.logger.info(`${provider}: signed in account ${account.id}`);
    return { provider, id: account.id, label: account.label, active: true };
  }

  private async signIn(provider: ProviderId, options: LoginOptions): Promise<AccountCredential> {
    const keyClient = this.keyClients.find((c) => c.provider === provider);
    if (keyClient !== undefined) {
      if (options.manual || options.fresh) throw new InvalidRequestError(`${provider} signs in with an API key; --manual and --new do not apply`);
      return keyClient.account(await this.secrets.prompt(keyClient.question));
    }
    const client = this.clients.find((c) => c.provider === provider);
    // Composition wires a client for every ENABLED provider only (plan D4).
    if (client === undefined) throw new ProviderDisabledError(provider);
    const attempt = this.attempt(options.fresh);
    return options.manual ? this.manualLogin(client, attempt, options) : this.loopbackLogin(client, attempt, options);
  }

  /**
   * Fresh state, OIDC nonce and PKCE pair per login; each client sends only what its official client does (PKCE: Claude
   * and OpenAI, not Google; the nonce: OpenAI).
   */
  private attempt(fresh: boolean): Attempt {
    const state = base64UrlEncode(this.random.bytes(32));
    const nonce = base64UrlEncode(this.random.bytes(32));
    const verifier = base64UrlEncode(this.random.bytes(32));
    return { state, nonce, verifier, challenge: base64UrlEncode(this.hash.sha256(verifier)), fresh };
  }

  private async loopbackLogin(client: OAuthClientPort, attempt: Attempt, options: LoginOptions): Promise<AccountCredential> {
    const server = this.servers.create();
    const redirectUri = client.redirectUri(await server.start(client.callbackPath));
    const { state, nonce } = attempt;
    try {
      const url = await client.authorizeUrl({ redirectUri, state, nonce, codeChallenge: attempt.challenge, fresh: attempt.fresh });
      options.onAuthorizeUrl(url);
      await this.browser.open(url).catch((error: unknown) => this.logger.warn(`${client.provider}: could not open the browser (${String(error)}); open the URL by hand`));
      const query = await server.waitForCallback(options.timeoutMs);
      let account: AccountCredential;
      try {
        const code = codeFromCallback(client.provider, query, state);
        account = await client.exchange({ code, state, redirectUri, codeVerifier: attempt.verifier, nonce, callback: query });
      } catch (error) {
        await server.finish({ status: 400, text: `Sign-in failed: ${errorMessage(error)}. Close this tab and retry.` });
        throw error;
      }
      const redirect = client.successRedirect(account);
      await server.finish(redirect !== undefined ? { redirect } : { status: 200, text: `Signed in to ${client.provider} as ${account.label}. You can close this tab.` });
      return account;
    } finally {
      await server.stop();
    }
  }

  private async manualLogin(client: OAuthClientPort, attempt: Attempt, options: LoginOptions): Promise<AccountCredential> {
    const redirectUri = client.manualRedirectUri;
    if (redirectUri === undefined) throw new InvalidRequestError(`${client.provider} has no paste-code login; use the browser login`);
    const { state, nonce } = attempt;
    const url = await client.authorizeUrl({ redirectUri, state, nonce, codeChallenge: attempt.challenge, fresh: attempt.fresh });
    options.onAuthorizeUrl(url);
    const code = codeFromManualInput(client.provider, await this.manual.prompt(url), state);
    return client.exchange({ code, state, redirectUri, codeVerifier: attempt.verifier, nonce, callback: {} });
  }
}
