// The active API-key account of one gateway provider, read from the router's own account file (plan P4.6 §2 item 3).
import { activeAccount } from "@inference-router/core/domain/accounts.ts";
import { apiKeyOf } from "@inference-router/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { GatewayKeySessionPort, type KeySession } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";

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
