// The reference model catalog (plan 2026-10-16 rule M4): `https://models.opencode.ai/api.json`, the catalog opencode v2
// loads (core/src/models-dev.ts), read at most once per 24 h; the parsed copy is kept in the proxy's state; when the
// catalog cannot be read: the stored copy, else the built-in copy generated from docs/reference/specs.
import { isJsonObject, type JsonValue } from "@accounts-proxy/core/domain/json.ts";
import { parseReference, referenceCatalog, referenceRecord, type ReferenceRecord } from "@accounts-proxy/core/domain/model-details.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { ModelReferencePort, type ReferenceListing } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export const MODEL_REFERENCE_URL = "https://models.opencode.ai/api.json";
export const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
/** The full document is about 6 MB. */
export const REFERENCE_TIMEOUT_MS = 30_000;
const CACHE_KEY = "model-reference";

type Snapshot = { readonly version: 1; readonly fetchedAt: number; readonly catalog: ReferenceRecord };

const isSnapshot = (v: JsonValue | undefined): v is Snapshot & JsonValue => isJsonObject(v) && v["version"] === 1 && typeof v["fetchedAt"] === "number" && isJsonObject(v["catalog"]);

export class ModelReferenceCatalog extends ModelReferencePort {
  private memory: Snapshot | undefined;

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly store: KeyValueStorePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly url: string,
    private readonly builtin: ReferenceRecord,
  ) {
    super();
  }

  async reference(): Promise<ReferenceListing> {
    const fromMemory = this.memory !== undefined;
    const cached = this.memory ?? (await this.loadCache());
    if (cached !== undefined && this.clock.now() - cached.fetchedAt < REFERENCE_TTL_MS) return { source: fromMemory ? "live" : "cache", catalog: referenceCatalog(cached.catalog) };
    try {
      const res = await this.transport.send({ method: "GET", url: this.url, headers: { accept: "application/json" }, timeoutMs: REFERENCE_TIMEOUT_MS });
      const text = await readAll(res.body);
      if (res.status !== 200) throw new Error(`GET ${this.url} HTTP ${res.status}`);
      const catalog = parseReference(JSON.parse(text));
      if (catalog.size === 0) throw new Error(`GET ${this.url}: no reference provider in the document`);
      const snapshot: Snapshot = { version: 1, fetchedAt: this.clock.now(), catalog: referenceRecord(catalog) };
      this.memory = snapshot;
      await this.store.write(CACHE_KEY, snapshot as unknown as JsonValue).catch((error: unknown) => this.logger.warn(`model reference: cache write failed: ${String(error)}`));
      return { source: "live", catalog };
    } catch (error) {
      this.logger.warn(`model reference: ${this.url} unavailable (${errorMessage(error)})`);
      return cached !== undefined ? { source: "cache", catalog: referenceCatalog(cached.catalog) } : { source: "static", catalog: referenceCatalog(this.builtin) };
    }
  }

  private async loadCache(): Promise<Snapshot | undefined> {
    try {
      const value = await this.store.read(CACHE_KEY);
      return isSnapshot(value) ? value : undefined;
    } catch (error) {
      this.logger.warn(`model reference: cache unreadable: ${String(error)}`);
      return undefined;
    }
  }
}
