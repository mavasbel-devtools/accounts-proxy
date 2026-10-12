// A gateway's model list (rule G5): the live list (kept in memory and stored for 24 h), else the stored copy, else the
// built-in list generated from the committed vendor list. A live list is shown as the vendor answers it, even empty:
// routing does not depend on it (a model the list does not describe is forwarded as sent, rule Z6).
import type { JsonValue } from "@inference-router/core/domain/json.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import type { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { CATALOG_TTL_MS, isCatalogSnapshot, type CatalogSnapshot, type GatewayModel } from "@inference-router/provider-gateway/domain/gateway.ts";
import { GatewayCatalogPort, type GatewayCatalogSourcePort, type GatewayKeySessionPort, type GatewayListing } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";

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
  ) {
    super();
  }

  private get cacheKey(): string {
    return `${this.provider}/model-catalog`;
  }

  async listing(): Promise<GatewayListing> {
    const fromMemory = this.memory !== undefined;
    const cached = this.memory ?? (await this.loadCache());
    if (cached !== undefined && this.clock.now() - cached.fetchedAt < CATALOG_TTL_MS) return { source: fromMemory ? "live" : "cache", models: cached.models };
    try {
      const models = await this.source.fetch(await this.session.optionalKey());
      const snapshot: CatalogSnapshot = { version: 1, fetchedAt: this.clock.now(), models };
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
