// Live model catalog. Contract of opencode-claude-auth @ 6292741 (AGENTS.md §9, AnthropicModelsApiAdapter,
// RefreshModelCatalogUseCase): fresh cache (younger than `modelListMaxAgeMinutes`, default 24 h as in the plugin; a
// refresh skips it) → live paginated GET /v1/models (limit 100, ≤ 10 pages, 3 s per page, cursor last_id else final
// id) → on failure or empty: stale non-empty cache → static minimum. Never empty.
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { isSnapshot, nextCursor, parseCatalogEntry, parseModelSelector, type CatalogSnapshot, type ModelsPage } from "@accounts-proxy/provider-claude/domain/catalog.ts";
import { ANTHROPIC_VERSION_HEADER, CATALOG } from "@accounts-proxy/provider-claude/domain/constants.ts";
import { STATIC_CATALOG, type CatalogModelEntry } from "@accounts-proxy/provider-claude/domain/model-envelope.ts";
import { ClaudeCatalogPort, type CatalogListing, type ClaudeSessionPort } from "@accounts-proxy/provider-claude/ports/outbound/claude.ts";

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
    private readonly maxAgeMs: number,
  ) {
    super();
  }

  /** `live` when fetched by this process (memoized for the max age), `cache` from the stored copy, `static` the minimum. */
  listing(): Promise<CatalogListing> {
    return this.load(false);
  }

  refresh(): Promise<CatalogListing> {
    return this.load(true);
  }

  private async load(now: boolean): Promise<CatalogListing> {
    const fromMemory = this.memory !== undefined;
    const cached = this.memory ?? (await this.loadCache());
    if (!now && cached !== undefined && this.clock.now() - cached.fetchedAt < this.maxAgeMs) return { source: fromMemory ? "live" : "cache", entries: cached.models };
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
    const active = await this.session.active();
    const { accessToken, organizationUuid } = active.account;

    if (organizationUuid) {
      await this.performStartupReads(accessToken);
      try {
        const selectorUrl = `${this.apiBase}/api/organizations/${organizationUuid}/model_selector/cc`;
        const res = await this.transport.send({
          method: "GET",
          url: selectorUrl,
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            "user-agent": "claude-cli/2.1.304 (external, sdk-cli)",
            authorization: `Bearer ${accessToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-client-platform": "claude_code_sdk",
            "x-organization-uuid": organizationUuid,
          },
          timeoutMs: CATALOG.timeoutMs,
        });
        if (res.status !== 200) throw new Error(`model_selector HTTP ${res.status}`);
        const text = await readAll(res.body);
        const models = parseModelSelector(JSON.parse(text));
        if (models.length > 0) return models;
      } catch (error) {
        this.logger.info(`claude: model_selector failed (${errorMessage(error)}), trying /v1/models`);
      }
    }

    return this.fetchV1Models(accessToken);
  }

  private async performStartupReads(accessToken: string): Promise<void> {
    const headers = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": "claude-code/2.1.304",
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    };
    await Promise.allSettled([
      this.transport.send({ method: "GET", url: `${this.apiBase}/api/claude_code_penguin_mode`, headers, timeoutMs: CATALOG.timeoutMs }),
      this.transport.send({ method: "GET", url: `${this.apiBase}/api/claude_code_grove`, headers, timeoutMs: CATALOG.timeoutMs }),
      this.transport.send({ method: "GET", url: `${this.apiBase}/api/claude_cli/bootstrap?entrypoint=sdk-cli&model=claude-opus-5-5`, headers, timeoutMs: CATALOG.timeoutMs }),
    ]);
  }

  private async fetchV1Models(accessToken: string): Promise<CatalogModelEntry[]> {
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
