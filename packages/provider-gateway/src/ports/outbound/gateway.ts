// Gateway-internal abstractions. GatewayProvider and GatewayCatalog depend only on these; vendor packages implement
// the catalog source and the key login, composition wires them.
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";
import type { GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";

export type KeySession = {
  /** The active account's id. */
  readonly accountId: string;
  /** Sent as the endpoint's key header. */
  readonly key: string;
  /** Further headers the account's requests carry (the OpenCode workspace's headers, Z20). */
  readonly headers?: Readonly<Record<string, string>>;
};

/** The active account of one gateway provider and the credential its requests carry (G6; OpenCode Console Z18). */
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
  /** Live list (cached for `modelListMaxAgeMinutes`), else the stored copy, else the built-in list (G5). */
  abstract listing(): Promise<GatewayListing>;
  /** The live list read now whatever the cache's age, with the same fallbacks (plan 2026-10-26 R2). */
  abstract refresh(): Promise<GatewayListing>;
}
