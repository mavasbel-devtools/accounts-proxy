// Fresh-token session over the router's own Antigravity pool. Ports opencode-antigravity-auth @ 5c6f7c2
// RefreshSessionUseCase (refreshedActive / forceRotate) with two fixes:
//   G5 every path, including chat, refreshes proactively (source StreamChatUseCase used bare loadActive, relying on a
//      401 retry — a violation of the source's own token lifecycle law);
//   G2 the refresh is single-flight in process and runs under a cross-process lock that re-reads the pool first.
// The source's host-mirror bootstrap (opencode auth.json) is not carried: the router never reads foreign stores (D5).
import { activeAccount, replaceAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { fromCredential, isExpired, rotated, toCredential, type AntigravityAccount } from "../../domain/account.ts";
import { AntigravitySessionPort, type ActiveAccount, type AntigravityOAuthPort } from "../../ports/outbound/antigravity.ts";

const PROVIDER = "antigravity";
export const REFRESH_LOCK = "antigravity-refresh";

export class AntigravitySession extends AntigravitySessionPort {
  private inflight: Promise<ActiveAccount> | undefined;

  constructor(
    private readonly store: CredentialStorePort,
    private readonly oauth: AntigravityOAuthPort,
    private readonly lock: LockPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async active(): Promise<ActiveAccount> {
    const current = await this.load();
    if (!isExpired(current.account.tokens, this.clock.now())) return current;
    const inflight =
      this.inflight ??
      this.lock.withLock(REFRESH_LOCK, () => this.rotateUnderLock(false)).finally(() => {
        this.inflight = undefined;
      });
    this.inflight = inflight;
    return inflight;
  }

  forceRotate(current: ActiveAccount): Promise<ActiveAccount> {
    return this.lock.withLock(REFRESH_LOCK, async () => {
      const latest = await this.load();
      // Another caller already rotated the token we saw fail: reuse it instead of spending the refresh token again.
      if (latest.id === current.id && latest.account.tokens.accessToken !== current.account.tokens.accessToken) return latest;
      return this.rotateUnderLock(true);
    });
  }

  private async rotateUnderLock(force: boolean): Promise<ActiveAccount> {
    const { id, credential, account } = await this.loadWithCredential();
    if (!force && !isExpired(account.tokens, this.clock.now())) return { id, account };
    const tokens = rotated(account.tokens, await this.oauth.refresh(account.tokens));
    const updated: AntigravityAccount = { ...account, tokens };
    const pool = await this.store.load(PROVIDER);
    await this.store.save(PROVIDER, replaceAccount(pool, { ...toCredential(updated, id), label: credential.label }));
    this.logger.info(`${PROVIDER}: access token rotated for account ${id}`);
    return { id, account: updated };
  }

  private async load(): Promise<ActiveAccount> {
    const { id, account } = await this.loadWithCredential();
    return { id, account };
  }

  private async loadWithCredential(): Promise<{ id: string; credential: AccountCredential; account: AntigravityAccount }> {
    const credential = activeAccount(await this.store.load(PROVIDER));
    if (credential === undefined) throw new ProviderAuthRequiredError(PROVIDER, "no active account");
    const account = fromCredential(credential);
    if (account === undefined) throw new ProviderAuthRequiredError(PROVIDER, `stored credential of ${credential.id} is unreadable`);
    return { id: credential.id, credential, account };
  }
}
