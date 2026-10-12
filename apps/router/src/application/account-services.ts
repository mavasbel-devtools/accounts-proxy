// Account administration and usage reporting (plan D4: the user picks the active account by hand).
import { activeAccount, useAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { InvalidRequestError, ProviderDisabledError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { UsageReport } from "@inference-router/core/domain/usage.ts";
import { AccountAdminPort, UsagePort, type AccountSummary } from "@inference-router/core/ports/inbound/accounts.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";

export class AccountAdminService extends AccountAdminPort {
  constructor(private readonly store: CredentialStorePort) {
    super();
  }

  async list(provider: ProviderId): Promise<readonly AccountSummary[]> {
    const pool = await this.store.load(provider);
    const active = activeAccount(pool)?.id;
    return pool.accounts.map((a) => summary(provider, a, a.id === active));
  }

  async use(provider: ProviderId, accountId: string): Promise<AccountSummary> {
    const pool = await this.store.update(provider, (current) => useAccount(current, provider, accountId));
    return summary(provider, activeAccount(pool)!, true);
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
