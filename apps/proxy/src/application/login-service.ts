// Logins (plan D10; P4.6; P4.6 amendment A). A provider signs in by the first of these it has:
//   - an API key, when asked for (`--key` at a hidden prompt, `--from-opencode` imported once; N4, K3, K5);
//   - the device login (RFC 8628; OpenCode Console, K1): the provider's page approves a code while the proxy polls;
//   - the browser login: loopback listener on 127.0.0.1 + system browser + automatic redirect capture; `--manual` is
//     the provider's paste-code page, only for providers that have one (Claude, OpenRouter headless);
//   - an API key at the hidden prompt (the key-only gateways).
// PKCE (RFC 7636 S256) is used exactly when the provider's client uses it (Claude yes, Google/Antigravity no — both as
// their official clients do, see docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md).
// The account is stored for the provider that owns the accounts (`opencode-go` uses `opencode`'s, K2).
import { accountOwner, upsertAccount, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { SLOW_DOWN_STEP_MS } from "@accounts-proxy/core/domain/device-flow.ts";
import { InvalidRequestError, ProviderAuthRequiredError, ProviderDisabledError } from "@accounts-proxy/core/domain/errors.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { base64UrlEncode } from "@accounts-proxy/core/domain/services/base64url.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import { codeFromCallback, codeFromManualInput } from "@accounts-proxy/core/domain/services/oauth-flow.ts";
import { LoginPort, type AccountSummary, type LoginOptions } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { ApiKeyLoginPort, ForeignKeySourcePort, SecretPromptPort } from "@accounts-proxy/core/ports/outbound/api-key.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { DeviceLoginClientPort } from "@accounts-proxy/core/ports/outbound/device.ts";
import type { CallbackServerFactoryPort, ManualCodePort, OAuthClientPort } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { BrowserLauncherPort, ClockPort, HashPort, LoggerPort, RandomPort, TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";

type Attempt = { readonly state: string; readonly nonce: string; readonly verifier: string; readonly challenge: string; readonly fresh: boolean };

/** The login clients of the enabled providers and the services the logins use. */
export type LoginDependencies = {
  readonly clients: readonly OAuthClientPort[];
  readonly devices: readonly DeviceLoginClientPort[];
  readonly keyClients: readonly ApiKeyLoginPort[];
  readonly keySources: readonly ForeignKeySourcePort[];
  readonly servers: CallbackServerFactoryPort;
  readonly browser: BrowserLauncherPort;
  readonly manual: ManualCodePort;
  readonly secrets: SecretPromptPort;
  readonly store: CredentialStorePort;
  readonly random: RandomPort;
  readonly hash: HashPort;
  readonly clock: ClockPort;
  readonly timer: TimerPort;
  readonly logger: LoggerPort;
};

export class LoginService extends LoginPort {
  constructor(private readonly deps: LoginDependencies) {
    super();
  }

  async login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary> {
    const account = await this.signIn(provider, options);
    await this.deps.store.update(accountOwner(provider), (pool) => upsertAccount(pool, account));
    this.deps.logger.info(`${provider}: signed in account ${account.id}`);
    return { provider, id: account.id, label: account.label, active: true };
  }

  private async signIn(provider: ProviderId, options: LoginOptions): Promise<AccountCredential> {
    const { clients, devices, keyClients } = this.deps;
    const keyClient = keyClients.find((c) => c.provider === provider);
    const device = devices.find((c) => c.provider === provider);
    const client = clients.find((c) => c.provider === provider);
    // Composition wires clients for every ENABLED provider only (plan D4).
    if (keyClient === undefined && device === undefined && client === undefined) throw new ProviderDisabledError(provider);
    if (options.key || options.importFrom !== undefined) {
      if (keyClient === undefined) throw new InvalidRequestError(`${provider} has no API-key login`);
      this.noBrowserFlags(provider, options, "with an API key");
      return keyClient.account(await this.apiKey(provider, keyClient, options));
    }
    if (device !== undefined) {
      this.noBrowserFlags(provider, options, "with a device code");
      return this.deviceLogin(device, options);
    }
    if (client !== undefined) {
      const attempt = this.attempt(options.fresh);
      return options.manual ? this.manualLogin(client, attempt, options) : this.loopbackLogin(client, attempt, options);
    }
    this.noBrowserFlags(provider, options, "with an API key");
    return keyClient!.account(await this.deps.secrets.prompt(keyClient!.question));
  }

  private noBrowserFlags(provider: ProviderId, options: LoginOptions, how: string): void {
    if (options.manual || options.fresh) throw new InvalidRequestError(`${provider} signs in ${how}; --manual and --new do not apply`);
  }

  private async apiKey(provider: ProviderId, keyClient: ApiKeyLoginPort, options: LoginOptions): Promise<string> {
    if (options.importFrom === undefined) return this.deps.secrets.prompt(keyClient.question);
    // Composition wires a source for every KeyImportSource.
    const source = this.deps.keySources.find((s) => s.tool === options.importFrom)!;
    const key = await source.apiKey(provider);
    this.deps.logger.info(`${provider}: API key imported from ${source.tool}`);
    return key;
  }

  /**
   * RFC 8628: show the code and open the approval page, then poll every interval (5 s more after each `slow_down`)
   * until the provider answers, the code expires, or the login timeout passes.
   */
  private async deviceLogin(device: DeviceLoginClientPort, options: LoginOptions): Promise<AccountCredential> {
    const { clock, timer, browser, logger } = this.deps;
    const authorization = await device.start();
    options.onUserCode(authorization.userCode);
    options.onAuthorizeUrl(authorization.verificationUrl);
    await browser.open(authorization.verificationUrl).catch((error: unknown) => logger.warn(`${device.provider}: could not open the browser (${String(error)}); open the URL by hand`));
    const deadline = clock.now() + Math.min(authorization.expiresInMs, options.timeoutMs);
    let interval = authorization.intervalMs;
    for (;;) {
      if (clock.now() + interval > deadline) throw new ProviderAuthRequiredError(device.provider, "the device code was not approved in time");
      await timer.sleep(interval);
      const answer = await device.poll(authorization);
      if (answer.kind === "approved") return answer.account;
      if (answer.kind === "slow_down") interval += SLOW_DOWN_STEP_MS;
    }
  }

  /**
   * Fresh state, OIDC nonce and PKCE pair per login; each client sends only what its official client does (PKCE: Claude
   * and OpenAI, not Google; the nonce: OpenAI).
   */
  private attempt(fresh: boolean): Attempt {
    const { random, hash } = this.deps;
    const state = base64UrlEncode(random.bytes(32));
    const nonce = base64UrlEncode(random.bytes(32));
    const verifier = base64UrlEncode(random.bytes(32));
    return { state, nonce, verifier, challenge: base64UrlEncode(hash.sha256(verifier)), fresh };
  }

  private async loopbackLogin(client: OAuthClientPort, attempt: Attempt, options: LoginOptions): Promise<AccountCredential> {
    const server = this.deps.servers.create();
    const redirectUri = client.redirectUri(await server.start(client.callbackPath));
    const { state, nonce } = attempt;
    try {
      const url = await client.authorizeUrl({ redirectUri, state, nonce, codeChallenge: attempt.challenge, fresh: attempt.fresh });
      options.onAuthorizeUrl(url);
      await this.deps.browser.open(url).catch((error: unknown) => this.deps.logger.warn(`${client.provider}: could not open the browser (${String(error)}); open the URL by hand`));
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
    const code = codeFromManualInput(client.provider, await this.deps.manual.prompt(url), state);
    return client.exchange({ code, state, redirectUri, codeVerifier: attempt.verifier, nonce, callback: {} });
  }
}
