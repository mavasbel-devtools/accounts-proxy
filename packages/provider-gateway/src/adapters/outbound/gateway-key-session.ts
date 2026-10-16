// The active API-key account of one gateway provider, read from the proxy's own account file (plan P4.6 §2 item 3).
import { activeAccount } from "@accounts-proxy/core/domain/accounts.ts";
import { apiKeyOf } from "@accounts-proxy/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import { GatewayKeySessionPort, type KeySession } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";

export class GatewayKeySession extends GatewayKeySessionPort {
  constructor(
    private readonly provider: ProviderId,
    private readonly store: CredentialStorePort,
  ) {
    super();
  }

  async active(): Promise<KeySession> {
    const account = activeAccount(await this.store.load(this.provider));
    if (account === undefined) throw new ProviderAuthRequiredError(this.provider, "no active account");
    return { accountId: account.id, key: apiKeyOf(account) };
  }

  async optionalKey(): Promise<string | undefined> {
    const account = activeAccount(await this.store.load(this.provider));
    return account === undefined ? undefined : apiKeyOf(account);
  }
}
