// Model catalog (`fetchAvailableModels`). Source ResolveModelsUseCase: no static list; descriptors exclude tab/deprecated
// models (law 9). The list is the signed-in account's, kept under the shared model-list rules (ModelListCacheBase, plan
// 2026-10-28-13-40 M1): fetched at start, reused, refreshed in the background past `modelListMaxAgeMinutes`, and the
// saved copy answers while a fetch fails (there is no built-in list). Proxy additions: a list kept for another account
// is fetched again for the active one, and a requested id the list lacks fetches the list once more, so a model added
// upstream is usable without restarting the daemon.
import { activeAccount } from "@accounts-proxy/core/domain/accounts.ts";
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { KeptList, ListSnapshot } from "@accounts-proxy/core/domain/model-list.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import { ModelListCacheBase, type ModelListCachePort } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { toModelDescriptors, type ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import { AntigravityCatalogPort, type AntigravityApiPort, type AntigravityListing, type AntigravitySessionPort } from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";
import { withActive } from "@accounts-proxy/provider-antigravity/adapters/outbound/with-active.ts";

export const ANTIGRAVITY_CATALOG_KEY = "antigravity/model-catalog";

/** One account's list: the account it was fetched for and its models. */
export type AccountModels = { readonly account: string; readonly descriptors: readonly ModelDescriptor[] };

export class AntigravityCatalog extends AntigravityCatalogPort {
  constructor(
    private readonly list: ModelListCachePort<AccountModels>,
    private readonly store: CredentialStorePort,
  ) {
    super();
  }

  /**
   * The kept list while it is the active account's. The active account is read from the accounts file without renewing
   * its token, so a list kept while the token cannot be renewed (no network) is still answered.
   */
  async listing(): Promise<AntigravityListing> {
    const active = activeAccount(await this.store.load("antigravity"));
    if (active === undefined) throw new ProviderAuthRequiredError("antigravity", "no active account");
    const kept = await this.list.read();
    return listingOf(kept.value.account === active.id ? kept : await this.list.fetch("account changed"));
  }

  async refresh(): Promise<AntigravityListing> {
    return listingOf(await this.list.fetch("refresh"));
  }

  async descriptor(wireId: string): Promise<ModelDescriptor | undefined> {
    const find = (listing: AntigravityListing) => listing.descriptors.find((d) => d.wireId === wireId);
    return find(await this.listing()) ?? find(listingOf(await this.list.fetch("unknown model")));
  }
}

const listingOf = ({ source, value }: KeptList<AccountModels>): AntigravityListing => ({ source, descriptors: value.descriptors });

/** The active account's `fetchAvailableModels` answer and its stored copy. */
export class AntigravityModelList extends ModelListCacheBase<AccountModels> {
  protected readonly label = "antigravity";
  protected readonly cacheKey = ANTIGRAVITY_CATALOG_KEY;

  constructor(
    private readonly api: AntigravityApiPort,
    private readonly session: AntigravitySessionPort,
    store: KeyValueStorePort,
    clock: ClockPort,
    logger: LoggerPort,
    maxAgeMs: number,
  ) {
    super(store, clock, logger, maxAgeMs);
  }

  protected async fetchLive(): Promise<AccountModels> {
    return withActive(this.session, async (active) => ({ account: active.id, descriptors: toModelDescriptors(await this.api.fetchAvailableModels(active.account.tokens)) }));
  }

  protected decode(value: JsonValue | undefined): ListSnapshot<AccountModels> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const v = value as { version?: unknown; fetchedAt?: unknown; account?: unknown; descriptors?: unknown };
    if (v.version !== 1 || typeof v.fetchedAt !== "number" || typeof v.account !== "string" || !Array.isArray(v.descriptors)) return undefined;
    return { fetchedAt: v.fetchedAt, value: { account: v.account, descriptors: v.descriptors as ModelDescriptor[] } };
  }

  protected encode(snapshot: ListSnapshot<AccountModels>): JsonValue {
    return { version: 1, fetchedAt: snapshot.fetchedAt, account: snapshot.value.account, descriptors: snapshot.value.descriptors } as unknown as JsonValue;
  }

  protected count(value: AccountModels): number {
    return value.descriptors.length;
  }

  protected builtin(): undefined {
    return undefined;
  }
}
