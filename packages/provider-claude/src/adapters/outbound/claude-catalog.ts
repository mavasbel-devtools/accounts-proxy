// Live model catalog. Contract of opencode-claude-auth @ 6292741 (AGENTS.md §9, AnthropicModelsApiAdapter,
// RefreshModelCatalogUseCase): fresh cache (< 24 h) → live paginated GET /v1/models (limit 100, ≤ 10 pages, 3 s per
// page, cursor last_id else final id) → on failure or empty: stale non-empty cache → static minimum. Never empty.
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { JsonValue } from "@inference-router/core/domain/json.ts";
import type { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { isSnapshot, nextCursor, parseCatalogEntry, type CatalogSnapshot, type ModelsPage } from "@inference-router/provider-claude/domain/catalog.ts";
import { ANTHROPIC_VERSION_HEADER, CATALOG } from "@inference-router/provider-claude/domain/constants.ts";
import { STATIC_CATALOG, type CatalogModelEntry } from "@inference-router/provider-claude/domain/model-envelope.ts";
import { ClaudeCatalogPort, type CatalogListing, type ClaudeSessionPort } from "@inference-router/provider-claude/ports/outbound/claude.ts";

export const CATALOG_KEY = "claude/model-catalog";

export class ClaudeCatalog extends ClaudeCatalogPort {
  private memory: CatalogSnapshot | undefined;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly session: ClaudeSessionPort,
    private readonly store: KeyValueStorePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  /** `live` when fetched by this call (memoized for the TTL), `cache` from the stored copy, `static` the minimum. */
  async listing(): Promise<CatalogListing> {
    const fromMemory = this.memory !== undefined;
    const cached = this.memory ?? (await this.loadCache());
    if (cached !== undefined && this.clock.now() - cached.fetchedAt < CATALOG.ttlMs) return { source: fromMemory ? "live" : "cache", entries: cached.models };
    try {
      const models = await this.fetchLive();
      if (models.length === 0) throw new Error("live catalog is empty");
      const snapshot: CatalogSnapshot = { version: 2, fetchedAt: this.clock.now(), models };
      this.memory = snapshot;
      await this.store.write(CATALOG_KEY, snapshot as unknown as JsonValue).catch((error: unknown) => {
        this.logger.warn(`claude: catalog cache write failed: ${String(error)}`);
      });
      return { source: "live", entries: models };
    } catch (error) {
      this.logger.warn(`claude: live catalog unavailable (${errorMessage(error)})`);
      return cached !== undefined ? { source: "cache", entries: cached.models } : { source: "static", entries: STATIC_CATALOG };
    }
  }

  private async loadCache(): Promise<CatalogSnapshot | undefined> {
    try {
      const value = await this.store.read(CATALOG_KEY);
      return isSnapshot(value) ? value : undefined;
    } catch (error) {
      this.logger.warn(`claude: catalog cache unreadable: ${String(error)}`);
      return undefined;
    }
  }

  private async fetchLive(): Promise<CatalogModelEntry[]> {
    const { accessToken } = await this.session.freshTokens();
    const out: CatalogModelEntry[] = [];
    let after: string | undefined;
    for (let page = 0; page < CATALOG.maxPages; page++) {
      const url = new URL(`${this.apiBase}/v1/models`);
      url.searchParams.set("limit", String(CATALOG.pageSize));
      if (after !== undefined) url.searchParams.set("after_id", after);
      const res = await this.transport.send({
        method: "GET",
        url: url.toString(),
        headers: { authorization: `Bearer ${accessToken}`, "anthropic-version": ANTHROPIC_VERSION_HEADER, "content-type": "application/json" },
        timeoutMs: CATALOG.timeoutMs,
      });
      const text = await readAll(res.body);
      if (res.status !== 200) throw new Error(`models catalog HTTP ${res.status}`);
      const parsed = JSON.parse(text) as ModelsPage;
      for (const raw of parsed.data ?? []) {
        const entry = parseCatalogEntry(raw);
        if (entry) out.push(entry);
      }
      after = nextCursor(parsed, out);
      if (after === undefined) return out;
    }
    return out;
  }
}
