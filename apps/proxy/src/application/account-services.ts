// Account administration and usage reporting (plan D4: the user picks the active account by hand). A provider that
// shares another's accounts (opencode-go, P4.6 K2) lists and chooses among the owner's.
import { accountOwner, activeAccount, removeAccount, useAccount, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { InvalidRequestError, ProviderDisabledError } from "@accounts-proxy/core/domain/errors.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import type { UsageReport } from "@accounts-proxy/core/domain/usage.ts";
import { AccountAdminPort, UsagePort, type AccountSummary } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { UsageReporterPort } from "@accounts-proxy/core/ports/outbound/usage.ts";

export class AccountAdminService extends AccountAdminPort {
  constructor(private readonly store: CredentialStorePort) {
    super();
  }

  async list(provider: ProviderId): Promise<readonly AccountSummary[]> {
    const pool = await this.store.load(accountOwner(provider));
    const active = activeAccount(pool)?.id;
    return pool.accounts.map((a) => summary(provider, a, a.id === active));
  }

  async use(provider: ProviderId, accountId: string): Promise<AccountSummary> {
    const pool = await this.store.update(accountOwner(provider), (current) => useAccount(current, provider, accountId));
    return summary(provider, activeAccount(pool)!, true);
  }

  async remove(provider: ProviderId, accountId: string): Promise<readonly AccountSummary[]> {
    const pool = await this.store.update(accountOwner(provider), (current) => removeAccount(current, provider, accountId));
    return pool.accounts.map((a) => summary(provider, a, a.id === pool.activeId));
  }
}

export class UsageService extends UsagePort {
  constructor(
    private readonly enabled: readonly ProviderId[],
    private readonly reporters: readonly UsageReporterPort[],
  ) {
    super();
  }

  async usage(provider: ProviderId): Promise<UsageReport> {
    if (!this.enabled.includes(provider)) throw new ProviderDisabledError(provider);
    const reporter = this.reporters.find((r) => r.provider === provider);
    if (reporter === undefined) throw new InvalidRequestError(`${provider} does not report usage`);
    return reporter.usage();
  }
}

function summary(provider: ProviderId, account: AccountCredential, active: boolean): AccountSummary {
  return { provider, id: account.id, label: account.label, active, ...(account.needsLogin !== undefined ? { needsLogin: account.needsLogin } : {}) };
}
