// OAuth session over the proxy's own account pool: one abstraction tree for every subscription provider (plan v4 H-a).
//   OAuthSessionPort<A>   what the provider adapters depend on (the active account with a usable access token)
//   OAuthSessionBase<A>   the renewal rules, written once; each provider supplies decode/encode/renew
// Rules:
//   - proactive renewal when the token is within the provider's expiry buffer; concurrent callers in one process share
//     one renewal (single flight), and the renewal runs under a cross-process lock that re-reads the pool first, so a
//     renewal another process already did is reused instead of spending the refresh token again;
//   - the renewed credential is written through CredentialStorePort.update, re-reading the pool after the token call:
//     a login or `account use` that ran meanwhile is never undone, and a credential written meanwhile for the same
//     account (a new login) is kept instead of being overwritten (H1);
//   - a transient renewal failure (timeout, unreachable, 5xx) keeps using a stored token that has not expired (H4), and
//     no new attempt is made for that token during RENEWAL_RETRY_AFTER_MS;
//   - a rejected refresh grant marks the account needsLogin, and later calls fail fast without calling the token
//     endpoint until a new login replaces the account (H6).
import { activeAccount, markNeedsLogin, RENEWAL_RETRY_AFTER_MS, replaceAccount, type AccountCredential, type AccountPool } from "@accounts-proxy/core/domain/accounts.ts";
import { isTransientUpstream, ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { ClockPort, LockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export type Session<A> = { readonly id: string; readonly account: A };
export type SessionTokens = { readonly accessToken: string; readonly refreshToken?: string; readonly expiresAt: number };

export abstract class OAuthSessionPort<A> {
  /** The active account, with an access token valid beyond the provider's expiry buffer. */
  abstract active(): Promise<Session<A>>;
  /**
   * Renew although the stored expiry says the token is valid: the upstream rejected `seen` with 401 (clock skew, server
   * side revocation). A token another caller renewed after `seen` is reused instead.
   */
  abstract forceRenew(seen: Session<A>): Promise<Session<A>>;
}

export abstract class OAuthSessionBase<A> extends OAuthSessionPort<A> {
  private inflight: Promise<Session<A>> | undefined;
  /** The access token whose renewal last failed transiently, and when the next attempt is allowed. */
  private cooldown: { readonly accessToken: string; readonly until: number } | undefined;

  protected abstract readonly provider: ProviderId;
  /** Name of the cross-process renewal lock. */
  protected abstract readonly lockName: string;
  /** Renew this long before the stored expiry. */
  protected abstract readonly expiryBufferMs: number;
  protected abstract tokensOf(account: A): SessionTokens;
  /** The provider's view of a stored credential; undefined when the stored shape is not this provider's. */
  protected abstract decode(credential: AccountCredential): A | undefined;
  /** The stored credential for a renewed account, keeping `stored`'s id and label. */
  protected abstract encode(account: A, stored: AccountCredential): AccountCredential;
  /** One token-endpoint renewal; ProviderAuthRequiredError when the grant is rejected. */
  protected abstract renew(account: A): Promise<A>;

  constructor(
    protected readonly store: CredentialStorePort,
    protected readonly lock: LockPort,
    protected readonly clock: ClockPort,
    protected readonly logger: LoggerPort,
  ) {
    super();
  }

  async active(): Promise<Session<A>> {
    const current = await this.load();
    if (!this.expiring(current) || this.coolingDown(current)) return current;
    const inflight =
      this.inflight ??
      this.lock.withLock(this.lockName, () => this.renewUnderLock(undefined)).finally(() => {
        this.inflight = undefined;
      });
    this.inflight = inflight;
    return inflight;
  }

  forceRenew(seen: Session<A>): Promise<Session<A>> {
    return this.lock.withLock(this.lockName, () => this.renewUnderLock(seen));
  }

  private async renewUnderLock(seen: Session<A> | undefined): Promise<Session<A>> {
    const latest = await this.load();
    if (seen === undefined ? !this.expiring(latest) : latest.id !== seen.id || this.access(latest) !== this.access(seen)) return latest;
    let renewed: A;
    try {
      renewed = await this.renew(latest.account);
    } catch (error) {
      if (error instanceof ProviderAuthRequiredError) {
        await this.store.update(this.provider, (pool) => {
          const stored = this.stored(pool, latest);
          return stored === undefined ? pool : markNeedsLogin(pool, stored, error.detail);
        });
        this.logger.warn(`${this.provider}: account ${latest.id} needs a new login (${error.detail})`);
        throw error;
      }
      if (seen === undefined && isTransientUpstream(error) && this.tokensOf(latest.account).expiresAt > this.clock.now()) {
        this.cooldown = { accessToken: this.access(latest), until: this.clock.now() + RENEWAL_RETRY_AFTER_MS };
        this.logger.warn(`${this.provider}: token renewal failed (${(error as Error).message}); using the stored token of ${latest.id} until it expires`);
        return latest;
      }
      throw error;
    }
    let kept = false;
    await this.store.update(this.provider, (pool) => {
      const stored = this.stored(pool, latest);
      kept = stored !== undefined;
      return stored === undefined ? pool : replaceAccount(pool, this.encode(renewed, stored));
    });
    this.logger.info(
      kept
        ? `${this.provider}: access token rotated for account ${latest.id}`
        : `${this.provider}: account ${latest.id} was written meanwhile (new login); the renewed token serves this call only`,
    );
    return { id: latest.id, account: renewed };
  }

  private async load(): Promise<Session<A>> {
    const credential = activeAccount(await this.store.load(this.provider));
    if (credential === undefined) throw new ProviderAuthRequiredError(this.provider, "no active account");
    if (credential.needsLogin !== undefined) throw new ProviderAuthRequiredError(this.provider, `account ${credential.id} needs a new login (${credential.needsLogin})`);
    const account = this.decode(credential);
    if (account === undefined) throw new ProviderAuthRequiredError(this.provider, `stored credential of ${credential.id} is unreadable`);
    return { id: credential.id, account };
  }

  /** The stored credential of this account, if it is still the one `session` was read from (nobody wrote it since). */
  private stored(pool: AccountPool, session: Session<A>): AccountCredential | undefined {
    const stored = pool.accounts.find((a) => a.id === session.id);
    const account = stored === undefined ? undefined : this.decode(stored);
    return account !== undefined && this.tokensOf(account).accessToken === this.access(session) ? stored : undefined;
  }

  /** A transient failure for this very token is recent, and the token itself is still valid. */
  private coolingDown(session: Session<A>): boolean {
    const now = this.clock.now();
    return this.cooldown !== undefined && this.cooldown.accessToken === this.access(session) && now < this.cooldown.until && this.tokensOf(session.account).expiresAt > now;
  }

  private access(session: Session<A>): string {
    return this.tokensOf(session.account).accessToken;
  }

  private expiring(session: Session<A>): boolean {
    return this.tokensOf(session.account).expiresAt - this.clock.now() <= this.expiryBufferMs;
  }
}
