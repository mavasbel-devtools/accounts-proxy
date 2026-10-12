// Gateway-internal abstractions. GatewayProvider and GatewayCatalog depend only on these; vendor packages implement
// the catalog source and the key login, composition wires them.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { ModelsSource } from "@inference-router/core/domain/models.ts";
import type { GatewayModel } from "@inference-router/provider-gateway/domain/gateway.ts";

export type KeySession = { readonly account: AccountCredential; readonly key: string };

/** The active API-key account of one provider (a fixed key: nothing to renew, G6). */
export abstract class GatewayKeySessionPort {
  /** The active account and its key; ProviderAuthRequiredError when there is none. */
  abstract active(): Promise<KeySession>;
  /** The active key, or undefined when no account is signed in (public catalogs need none). */
  abstract optionalKey(): Promise<string | undefined>;
}

/** One fetch of the vendor's live model list (with the key when the vendor's list needs one). */
export abstract class GatewayCatalogSourcePort {
  abstract fetch(key: string | undefined): Promise<readonly GatewayModel[]>;
}

export type GatewayListing = { readonly source: ModelsSource; readonly models: readonly GatewayModel[] };

export abstract class GatewayCatalogPort {
  /** Live list (24 h cache), else the stored copy, else the built-in list (G5). */
  abstract listing(): Promise<GatewayListing>;
}
