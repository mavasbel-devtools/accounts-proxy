// A gateway's model list (rule G5): the live list (kept in memory and stored; reused for `modelListMaxAgeMinutes`,
// default 24 h, unless a refresh asks for it now), else the stored copy, else the
// built-in list generated from the committed vendor list. A live list is shown as the vendor answers it, even empty:
// routing does not depend on it (a model the list does not describe is forwarded as sent, rule Z6).
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { isCatalogSnapshot, type CatalogSnapshot, type GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { GatewayCatalogPort, type GatewayCatalogSourcePort, type GatewayKeySessionPort, type GatewayListing } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";

export class GatewayCatalog extends GatewayCatalogPort {
  private memory: CatalogSnapshot | undefined;

  constructor(
    private readonly provider: ProviderId,
    private readonly source: GatewayCatalogSourcePort,
    private readonly session: GatewayKeySessionPort,
    private readonly store: KeyValueStorePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly builtin: readonly GatewayModel[],
    private readonly maxAgeMs: number,
  ) {
    super();
  }

  private get cacheKey(): string {
    return `${this.provider}/model-catalog`;
  }

  listing(): Promise<GatewayListing> {
    return this.load(false);
  }

  refresh(): Promise<GatewayListing> {
    return this.load(true);
  }

  private async load(now: boolean): Promise<GatewayListing> {
    const fromMemory = this.memory !== undefined;
    const cached = this.memory ?? (await this.loadCache());
    if (!now && cached !== undefined && this.clock.now() - cached.fetchedAt < this.maxAgeMs) return { source: fromMemory ? "live" : "cache", models: cached.models };
    try {
      const models = await this.source.fetch(await this.session.optionalKey());
      const snapshot: CatalogSnapshot = { version: 2, fetchedAt: this.clock.now(), models };
      this.memory = snapshot;
      await this.store.write(this.cacheKey, snapshot as unknown as JsonValue).catch((error: unknown) => this.logger.warn(`${this.provider}: model list cache write failed: ${String(error)}`));
      return { source: "live", models };
    } catch (error) {
      this.logger.warn(`${this.provider}: live model list unavailable (${errorMessage(error)})`);
      return cached !== undefined ? { source: "cache", models: cached.models } : { source: "static", models: this.builtin };
    }
  }

  private async loadCache(): Promise<CatalogSnapshot | undefined> {
    try {
      const value = await this.store.read(this.cacheKey);
      return isCatalogSnapshot(value) ? value : undefined;
    } catch (error) {
      this.logger.warn(`${this.provider}: model list cache unreadable: ${String(error)}`);
      return undefined;
    }
  }
}
