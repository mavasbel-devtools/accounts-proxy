// A gateway's model list (rule G5): the vendor's live list, else the stored copy, else the built-in list generated from
// the committed vendor list; reuse, background refresh and fallbacks are the shared model-list rules
// (ModelListCacheBase, plan 2026-10-28-13-40). A live list is shown as the vendor answers it, even empty: routing does
// not depend on it (a model the list does not describe is forwarded as sent, rule Z6).
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { ListSnapshot } from "@accounts-proxy/core/domain/model-list.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { ModelListCacheBase, type ModelListCachePort } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { isCatalogSnapshot, type CatalogSnapshot, type GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { GatewayCatalogPort, type GatewayCatalogSourcePort, type GatewayKeySessionPort, type GatewayListing } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";

type Models = readonly GatewayModel[];

/** A gateway's list over the shared model-list rules. */
export class GatewayCatalog extends GatewayCatalogPort {
  constructor(private readonly list: ModelListCachePort<Models>) {
    super();
  }

  async listing(): Promise<GatewayListing> {
    const { source, value } = await this.list.read();
    return { source, models: value };
  }

  async refresh(): Promise<GatewayListing> {
    const { source, value } = await this.list.fetch("refresh");
    return { source, models: value };
  }
}

/** A gateway's model list source and its stored copy (`<provider>/model-catalog`). */
export class GatewayModelList extends ModelListCacheBase<Models> {
  protected readonly cacheKey: string;

  constructor(
    protected readonly label: ProviderId,
    private readonly source: GatewayCatalogSourcePort,
    private readonly session: GatewayKeySessionPort,
    store: KeyValueStorePort,
    clock: ClockPort,
    logger: LoggerPort,
    private readonly builtinModels: Models,
    maxAgeMs: number,
  ) {
    super(store, clock, logger, maxAgeMs);
    this.cacheKey = `${label}/model-catalog`;
  }

  protected async fetchLive(): Promise<Models> {
    return this.source.fetch(await this.session.optionalKey());
  }

  protected decode(value: JsonValue | undefined): ListSnapshot<Models> | undefined {
    return isCatalogSnapshot(value) ? { fetchedAt: value.fetchedAt, value: value.models } : undefined;
  }

  protected encode(snapshot: ListSnapshot<Models>): JsonValue {
    const stored: CatalogSnapshot = { version: 2, fetchedAt: snapshot.fetchedAt, models: snapshot.value };
    return stored as unknown as JsonValue;
  }

  protected count(value: Models): number {
    return value.length;
  }

  protected builtin(): Models {
    return this.builtinModels;
  }
}
