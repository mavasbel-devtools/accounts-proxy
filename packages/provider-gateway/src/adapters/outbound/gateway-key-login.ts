// API-key login of one gateway (plan P4.6 §2 item 4): the vendor's check of the key (where it documents one) gives the
// account identity; a vendor without one gets `key-<8 hex of SHA-256(key)>`.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { apiKeyAccount, keyAccountId, normalizeApiKey } from "@inference-router/core/domain/api-key.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { ApiKeyLoginPort } from "@inference-router/core/ports/outbound/api-key.ts";
import type { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { firstString } from "@inference-router/provider-gateway/domain/gateway.ts";

/** What the vendor's check reports about the key's owner (an absent id: the key-hash identity). */
export type KeyIdentity = { readonly id: string | undefined; readonly label: string | undefined };

export abstract class GatewayKeyLogin extends ApiKeyLoginPort {
  constructor(private readonly hash: HashPort) {
    super();
  }

  abstract override readonly provider: ProviderId;

  /** The vendor's check of the key; throws when the vendor rejects it. */
  protected abstract identify(key: string): Promise<KeyIdentity>;

  async account(input: string): Promise<AccountCredential> {
    const key = normalizeApiKey(this.provider, input);
    const identity = await this.identify(key);
    const id = firstString(identity.id, keyAccountId(this.hash.sha256(key)))!;
    return apiKeyAccount(this.provider, id, firstString(identity.label, id)!, key);
  }
}
