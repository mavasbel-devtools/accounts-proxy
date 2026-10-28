// One kept model list (plan 2026-10-28-13-40 M1–M6), the rules written once for every provider list and the reference
// catalog:
//   - the list is kept in memory and stored; a process with no list in memory takes the stored copy while it is younger
//     than `modelListMaxAgeMinutes`, else it fetches and waits for that fetch;
//   - a list in memory is answered at once; when it is older than the max age, or a fetch failed at least
//     MODEL_LIST_RETRY_MS ago, the read also starts a fetch in the background (the reader does not wait for it);
//   - concurrent fetches share one (single flight); an explicit refresh waits for its fetch;
//   - a failed fetch keeps the list in memory, else the stored copy of any age, else the built-in list; with none of
//     them the fetch fails with its error, and the next read fetches again (there is nothing to answer meanwhile);
//   - every fetch logs one line when it starts and one when it ends; a read answered from memory logs nothing.
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import { MODEL_LIST_RETRY_MS, type KeptList, type ListFetchReason, type ListSnapshot } from "@accounts-proxy/core/domain/model-list.ts";
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export abstract class ModelListCachePort<T> {
  /** The kept list; fetches only as the rules above say. */
  abstract read(): Promise<KeptList<T>>;
  /** The list fetched now (joining a fetch already running); on failure the same fallbacks. */
  abstract fetch(reason: ListFetchReason): Promise<KeptList<T>>;
}

type Kept<T> = ListSnapshot<T> & { readonly source: ModelsSource };

export abstract class ModelListCacheBase<T> extends ModelListCachePort<T> {
  private memory: Kept<T> | undefined;
  private inflight: Promise<KeptList<T>> | undefined;
  /** When the last fetch failed; cleared by a successful fetch. */
  private failedAt: number | undefined;

  /** The name the log lines start with (`claude`, `model reference`). */
  protected abstract readonly label: string;
  /** The key of the stored copy. */
  protected abstract readonly cacheKey: string;
  /** One fetch from the list's source; throws when there is no usable list. */
  protected abstract fetchLive(): Promise<T>;
  /** The stored copy, or undefined when the stored value is not this list's shape. */
  protected abstract decode(value: JsonValue | undefined): ListSnapshot<T> | undefined;
  protected abstract encode(snapshot: ListSnapshot<T>): JsonValue;
  protected abstract count(value: T): number;
  /** The built-in list; undefined when the list has none. */
  protected abstract builtin(): T | undefined;

  constructor(
    protected readonly store: KeyValueStorePort,
    protected readonly clock: ClockPort,
    protected readonly logger: LoggerPort,
    protected readonly maxAgeMs: number,
  ) {
    super();
  }

  async read(): Promise<KeptList<T>> {
    if (this.memory === undefined) return this.firstRead();
    const now = this.clock.now();
    const due = this.failedAt !== undefined ? now - this.failedAt >= MODEL_LIST_RETRY_MS : now - this.memory.fetchedAt >= this.maxAgeMs;
    if (due && this.inflight === undefined) void this.fetch(this.failedAt !== undefined ? "retry" : "stale");
    return { source: this.memory.source, value: this.memory.value };
  }

  fetch(reason: ListFetchReason): Promise<KeptList<T>> {
    this.inflight ??= this.run(reason).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async firstRead(): Promise<KeptList<T>> {
    if (this.inflight !== undefined) return this.inflight;
    const stored = await this.loadStored();
    if (stored !== undefined && this.clock.now() - stored.fetchedAt < this.maxAgeMs) {
      this.memory = { ...stored, source: "cache" };
      this.logger.info(`${this.label}: model list loaded from the saved copy fetched ${iso(stored.fetchedAt)}: ${this.count(stored.value)} models`);
      return { source: "cache", value: stored.value };
    }
    return this.fetch(this.failedAt !== undefined ? "retry" : stored !== undefined ? "stale" : "first use");
  }

  private async run(reason: ListFetchReason): Promise<KeptList<T>> {
    const started = this.clock.now();
    this.logger.info(`${this.label}: model list ${reason}: fetching`);
    let value: T;
    try {
      value = await this.fetchLive();
    } catch (error) {
      return this.fallBack(reason, started, error);
    }
    const snapshot: ListSnapshot<T> = { fetchedAt: this.clock.now(), value };
    this.memory = { ...snapshot, source: "live" };
    this.failedAt = undefined;
    await this.store.write(this.cacheKey, this.encode(snapshot)).catch((error: unknown) => this.logger.warn(`${this.label}: model list cache write failed: ${String(error)}`));
    this.logger.info(`${this.label}: model list ${reason} → live: ${this.count(value)} models (${this.clock.now() - started} ms)`);
    return { source: "live", value };
  }

  private async fallBack(reason: ListFetchReason, started: number, error: unknown): Promise<KeptList<T>> {
    this.failedAt = this.clock.now();
    const failed = `${this.label}: model list ${reason} → failed after ${this.clock.now() - started} ms (${errorMessage(error)})`;
    if (this.memory === undefined) {
      const stored = await this.loadStored();
      if (stored !== undefined) this.memory = { ...stored, source: "cache" };
    }
    if (this.memory !== undefined) {
      const kept = this.memory.source === "static" ? "the built-in list" : this.memory.source === "live" ? `the list fetched ${iso(this.memory.fetchedAt)}` : `the saved copy fetched ${iso(this.memory.fetchedAt)}`;
      this.logger.warn(`${failed} → ${kept}: ${this.count(this.memory.value)} models`);
      // The answer of a failed fetch is a kept copy (`cache`), unless it is the built-in list.
      return { source: this.memory.source === "static" ? "static" : "cache", value: this.memory.value };
    }
    const builtin = this.builtin();
    if (builtin !== undefined) {
      this.memory = { fetchedAt: this.clock.now(), value: builtin, source: "static" };
      this.logger.warn(`${failed} → the built-in list: ${this.count(builtin)} models`);
      return { source: "static", value: builtin };
    }
    this.logger.warn(`${failed} → no list`);
    throw error;
  }

  private async loadStored(): Promise<ListSnapshot<T> | undefined> {
    try {
      return this.decode(await this.store.read(this.cacheKey));
    } catch (error) {
      this.logger.warn(`${this.label}: model list cache unreadable: ${String(error)}`);
      return undefined;
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
