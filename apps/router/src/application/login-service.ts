// Browser login (plan D10). Default: loopback listener on 127.0.0.1 + system browser + automatic redirect capture.
// Fallback (--manual): the provider's paste-code page, only for providers that have one (Claude).
// PKCE (RFC 7636 S256) is used exactly when the provider's client uses it (Claude yes, Google/Antigravity no — both as
// their official clients do, see docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md).
import { upsertAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { InvalidRequestError, ProviderDisabledError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { base64UrlEncode } from "@inference-router/core/domain/services/base64url.ts";
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import { codeFromCallback, codeFromManualInput, loopbackRedirectUri } from "@inference-router/core/domain/services/oauth-flow.ts";
import { LoginPort, type AccountSummary, type LoginOptions } from "@inference-router/core/ports/inbound/accounts.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { CallbackServerFactoryPort, ManualCodePort, OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import type { BrowserLauncherPort, HashPort, LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";

type Pkce = { readonly verifier: string; readonly challenge: string };

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
  ) {
    super();
  }

  async login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary> {
    const client = this.clients.find((c) => c.provider === provider);
    // Composition wires a client for every ENABLED provider only (plan D4).
    if (client === undefined) throw new ProviderDisabledError(provider);
    const state = base64UrlEncode(this.random.bytes(32));
    const pkce = this.pkce();
    const account = options.manual ? await this.manualLogin(client, state, pkce, options) : await this.loopbackLogin(client, state, pkce, options);
    await this.store.save(provider, upsertAccount(await this.store.load(provider), account));
    this.logger.info(`${provider}: signed in account ${account.id}`);
    return { provider, id: account.id, label: account.label, active: true };
  }

  /** One PKCE pair per login; each client sends it only if its official client does (Claude yes, Google no). */
  private pkce(): Pkce {
    const verifier = base64UrlEncode(this.random.bytes(32));
    return { verifier, challenge: base64UrlEncode(this.hash.sha256(verifier)) };
  }

  private async loopbackLogin(client: OAuthClientPort, state: string, pkce: Pkce, options: LoginOptions): Promise<AccountCredential> {
    const server = this.servers.create();
    const redirectUri = loopbackRedirectUri(await server.start(client.callbackPath), client.callbackPath);
    try {
      const url = client.authorizeUrl({ redirectUri, state, codeChallenge: pkce.challenge });
      options.onAuthorizeUrl(url);
      await this.browser.open(url).catch((error: unknown) => this.logger.warn(`${client.provider}: could not open the browser (${String(error)}); open the URL by hand`));
      const query = await server.waitForCallback(options.timeoutMs);
      let account: AccountCredential;
      try {
        const code = codeFromCallback(client.provider, query, state);
        account = await client.exchange({ code, state, redirectUri, codeVerifier: pkce.verifier });
      } catch (error) {
        await server.finish({ status: 400, text: `Sign-in failed: ${errorMessage(error)}. Close this tab and retry.` });
        throw error;
      }
      await server.finish({ redirect: client.successRedirect(account) });
      return account;
    } finally {
      await server.stop();
    }
  }

  private async manualLogin(client: OAuthClientPort, state: string, pkce: Pkce, options: LoginOptions): Promise<AccountCredential> {
    const redirectUri = client.manualRedirectUri;
    if (redirectUri === undefined) throw new InvalidRequestError(`${client.provider} has no paste-code login; use the browser login`);
    const url = client.authorizeUrl({ redirectUri, state, codeChallenge: pkce.challenge });
    options.onAuthorizeUrl(url);
    const code = codeFromManualInput(client.provider, await this.manual.prompt(url), state);
    return client.exchange({ code, state, redirectUri, codeVerifier: pkce.verifier });
  }
}
