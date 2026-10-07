// Fresh-token session over the router's own account pool. Fixes the source defect "refresh has no lock"
// (opencode-claude-auth RefreshSessionUseCase.ts:30-49): concurrent callers in one process share one in-flight
// refresh, and the refresh itself runs under a cross-process lock that re-reads the pool first, so a refresh
// already completed by another process is reused instead of spending (and possibly invalidating) the refresh token.
import { activeAccount, replaceAccount } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { fromAccount, isExpired, toAccount, type ClaudeTokens } from "../../domain/credential.ts";
import { ClaudeSessionPort, type ClaudeOAuthPort } from "../../ports/outbound/claude.ts";

const PROVIDER = "claude-subscription";
export const REFRESH_LOCK = "claude-subscription-refresh";

export class ClaudeSession extends ClaudeSessionPort {
  private inflight: Promise<ClaudeTokens> | undefined;

  constructor(
    private readonly store: CredentialStorePort,
    private readonly oauth: ClaudeOAuthPort,
    private readonly lock: LockPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async freshTokens(): Promise<ClaudeTokens> {
    const current = (await this.active()).tokens;
    if (!isExpired(current, this.clock.now())) return current;
    const inflight =
      this.inflight ??
      this.lock.withLock(REFRESH_LOCK, () => this.refreshUnderLock()).finally(() => {
        this.inflight = undefined;
      });
    this.inflight = inflight;
    return inflight;
  }

  private async refreshUnderLock(): Promise<ClaudeTokens> {
    const { pool, account, tokens } = await this.active();
    if (!isExpired(tokens, this.clock.now())) return tokens;
    const fresh = await this.oauth.refresh(tokens);
    await this.store.save(PROVIDER, replaceAccount(pool, { ...toAccount(fresh), id: account.id, label: account.label }));
    this.logger.info(`${PROVIDER}: access token rotated for account ${account.id}`);
    return fresh;
  }

  private async active() {
    const pool = await this.store.load(PROVIDER);
    const account = activeAccount(pool);
    if (account === undefined) throw new ProviderAuthRequiredError(PROVIDER, "no active account");
    const tokens = fromAccount(account);
    if (tokens === undefined) throw new ProviderAuthRequiredError(PROVIDER, `stored credential of ${account.id} is unreadable`);
    return { pool, account, tokens };
  }
}
