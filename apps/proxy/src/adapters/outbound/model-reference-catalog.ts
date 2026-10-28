// The reference model catalog (plan 2026-10-16 rule M4): `https://models.opencode.ai/api.json`, the catalog opencode v2
// loads (core/src/models-dev.ts); the parsed copy is kept in the proxy's state; when the catalog cannot be read: the
// stored copy, else the built-in copy generated from docs/reference/specs. Reuse and background refresh are the shared
// model-list rules (ModelListCacheBase, plan 2026-10-28-13-40).
import { isJsonObject, type JsonValue } from "@accounts-proxy/core/domain/json.ts";
import { countReferenceModels, parseReference, referenceCatalog, referenceRecord, type ReferenceRecord } from "@accounts-proxy/core/domain/model-details.ts";
import type { ListSnapshot } from "@accounts-proxy/core/domain/model-list.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { ModelListCacheBase, type ModelListCachePort } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";
import { ModelReferencePort, type ReferenceListing } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export const MODEL_REFERENCE_URL = "https://models.opencode.ai/api.json";
/** The full document is about 6 MB. */
export const REFERENCE_TIMEOUT_MS = 30_000;
const CACHE_KEY = "model-reference";

type Snapshot = { readonly version: 1; readonly fetchedAt: number; readonly catalog: ReferenceRecord };

const isSnapshot = (v: JsonValue | undefined): v is Snapshot & JsonValue => isJsonObject(v) && v["version"] === 1 && typeof v["fetchedAt"] === "number" && isJsonObject(v["catalog"]);

/** The reference catalog over the shared model-list rules. */
export class ModelReferenceCatalog extends ModelReferencePort {
  constructor(private readonly list: ModelListCachePort<ReferenceRecord>) {
    super();
  }

  async reference(): Promise<ReferenceListing> {
    const { source, value } = await this.list.read();
    return { source, catalog: referenceCatalog(value) };
  }

  async refresh(): Promise<ReferenceListing> {
    const { source, value } = await this.list.fetch("refresh");
    return { source, catalog: referenceCatalog(value) };
  }
}

/** The reference document's source and its stored copy (`model-reference`). */
export class ModelReferenceList extends ModelListCacheBase<ReferenceRecord> {
  protected readonly label = "model reference";
  protected readonly cacheKey = CACHE_KEY;

  constructor(
    private readonly transport: HttpTransportPort,
    store: KeyValueStorePort,
    clock: ClockPort,
    logger: LoggerPort,
    private readonly url: string,
    private readonly builtinCatalog: ReferenceRecord,
    maxAgeMs: number,
  ) {
    super(store, clock, logger, maxAgeMs);
  }

  protected async fetchLive(): Promise<ReferenceRecord> {
    const res = await this.transport.send({ method: "GET", url: this.url, headers: { accept: "application/json" }, timeoutMs: REFERENCE_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`GET ${this.url} HTTP ${res.status}`);
    const catalog = parseReference(JSON.parse(text));
    if (catalog.size === 0) throw new Error(`GET ${this.url}: no reference provider in the document`);
    return referenceRecord(catalog);
  }

  protected decode(value: JsonValue | undefined): ListSnapshot<ReferenceRecord> | undefined {
    return isSnapshot(value) ? { fetchedAt: value.fetchedAt, value: value.catalog } : undefined;
  }

  protected encode(snapshot: ListSnapshot<ReferenceRecord>): JsonValue {
    const stored: Snapshot = { version: 1, fetchedAt: snapshot.fetchedAt, catalog: snapshot.value };
    return stored as unknown as JsonValue;
  }

  /** The number of models over every reference provider. */
  protected count(value: ReferenceRecord): number {
    return countReferenceModels(value);
  }

  protected builtin(): ReferenceRecord {
    return this.builtinCatalog;
  }
}
