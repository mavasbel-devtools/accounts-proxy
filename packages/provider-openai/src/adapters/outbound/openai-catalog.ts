// Model list (M1–M2): the active registration's live `GET /v1/models` (cached 24 h, per issued client id because the
// list is per account), else the stored copy, else the built-in list. Never empty.
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { isSnapshot, parseModelList, STATIC_CATALOG, type CatalogSnapshot } from "@accounts-proxy/provider-openai/domain/catalog.ts";
import { CATALOG, USER_AGENT } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { OpenAICatalogPort, type CatalogListing, type OpenAISessionPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

export const CATALOG_KEY = "openai/model-catalog";

export class OpenAICatalog extends OpenAICatalogPort {
  private memory: CatalogSnapshot | undefined;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly session: OpenAISessionPort,
    private readonly store: KeyValueStorePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  async listing(): Promise<CatalogListing> {
    let accessToken: string;
    let clientId: string;
    try {
      ({ accessToken, clientId } = (await this.session.active()).account);
    } catch (error) {
      this.logger.warn(`openai: live model list unavailable (${errorMessage(error)})`);
      return { source: "static", entries: STATIC_CATALOG };
    }
    const fromMemory = this.memory?.clientId === clientId;
    const cached = fromMemory ? this.memory : await this.loadCache(clientId);
    if (cached !== undefined && this.clock.now() - cached.fetchedAt < CATALOG.ttlMs) return { source: fromMemory ? "live" : "cache", entries: cached.models };
    try {
      const models = await this.fetchLive(accessToken);
      if (models.length === 0) throw new Error("live model list is empty");
      const snapshot: CatalogSnapshot = { version: 2, clientId, fetchedAt: this.clock.now(), models };
      this.memory = snapshot;
      await this.store.write(CATALOG_KEY, snapshot as unknown as JsonValue).catch((error: unknown) => this.logger.warn(`openai: model list cache write failed: ${String(error)}`));
      return { source: "live", entries: models };
    } catch (error) {
      this.logger.warn(`openai: live model list unavailable (${errorMessage(error)})`);
      return cached !== undefined ? { source: "cache", entries: cached.models } : { source: "static", entries: STATIC_CATALOG };
    }
  }

  private async loadCache(clientId: string): Promise<CatalogSnapshot | undefined> {
    try {
      const value = await this.store.read(CATALOG_KEY);
      return isSnapshot(value, clientId) ? value : undefined;
    } catch (error) {
      this.logger.warn(`openai: model list cache unreadable: ${String(error)}`);
      return undefined;
    }
  }

  private async fetchLive(accessToken: string) {
    const res = await this.transport.send({
      method: "GET",
      url: `${this.apiBase}/v1/models`,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": USER_AGENT },
      timeoutMs: CATALOG.timeoutMs,
    });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`model list HTTP ${res.status}`);
    return parseModelList(JSON.parse(text));
  }
}
