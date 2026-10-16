// API-key login of one gateway (plan P4.6 §2 item 4): the vendor's check of the key (where it documents one) gives the
// account identity; a vendor without one gets `key-<8 hex of SHA-256(key)>`.
import { accountOwner, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { apiKeyAccount, keyAccountId, normalizeApiKey } from "@accounts-proxy/core/domain/api-key.ts";
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { ApiKeyLoginPort } from "@accounts-proxy/core/ports/outbound/api-key.ts";
import type { HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { firstString } from "@accounts-proxy/provider-gateway/domain/gateway.ts";

/**
 * What the vendor's check reports about the key's owner (an absent id: the key-hash identity), and any further account
 * data the requests need (`data`, stored next to the key).
 */
export type KeyIdentity = { readonly id: string | undefined; readonly label: string | undefined; readonly data?: JsonObject };

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
    // A provider that shares another's accounts (opencode-go, K2) stores the key under the owner's id.
    return apiKeyAccount(accountOwner(this.provider), id, firstString(identity.label, id)!, key, identity.data);
  }
}
