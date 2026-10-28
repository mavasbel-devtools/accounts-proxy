// The shared model-list rules (plan 2026-10-28-13-40 M1–M6) on a scripted list.
import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import { MODEL_LIST_RETRY_MS, type ListSnapshot } from "@accounts-proxy/core/domain/model-list.ts";
import { ModelListCacheBase } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";
import { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import { ClockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";

const MAX_AGE = 60 * 60_000;
const T0 = 1_800_000_000_000;

class FixedClock extends ClockPort {
  constructor(public time: number) {
    super();
  }
  now(): number {
    return this.time;
  }
}

class MemoryLogger extends LoggerPort {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`INFO ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`WARN ${message}`);
  }
  error(message: string): void {
    this.lines.push(`ERROR ${message}`);
  }
}

class MemoryKeyValueStore extends KeyValueStorePort {
  readonly values = new Map<string, JsonValue>();
  failRead: Error | undefined;
  failWrite: Error | undefined;
  async read(key: string): Promise<JsonValue | undefined> {
    if (this.failRead) throw this.failRead;
    return this.values.get(key);
  }
  async write(key: string, value: JsonValue): Promise<void> {
    if (this.failWrite) throw this.failWrite;
    this.values.set(key, value);
  }
}

/** A list whose source answers what `answers` says, in order (an Error is thrown); the last answer repeats. */
class ScriptedList extends ModelListCacheBase<readonly string[]> {
  protected readonly label = "test";
  protected readonly cacheKey = "test/model-catalog";
  calls = 0;
  release: (() => void) | undefined;

  constructor(
    private readonly answers: (readonly string[] | Error)[],
    store = new MemoryKeyValueStore(),
    clock = new FixedClock(T0),
    logger = new MemoryLogger(),
    private readonly fallback: readonly string[] | undefined = undefined,
    private readonly gated = false,
  ) {
    super(store, clock, logger, MAX_AGE);
  }

  get kv(): MemoryKeyValueStore {
    return this.store as MemoryKeyValueStore;
  }
  get time(): FixedClock {
    return this.clock as FixedClock;
  }
  get log(): MemoryLogger {
    return this.logger as MemoryLogger;
  }

  protected async fetchLive(): Promise<readonly string[]> {
    const answer = this.answers[Math.min(this.calls, this.answers.length - 1)]!;
    this.calls += 1;
    if (this.gated) await new Promise<void>((resolve) => (this.release = resolve));
    if (answer instanceof Error) throw answer;
    return answer;
  }
  protected decode(value: JsonValue | undefined): ListSnapshot<readonly string[]> | undefined {
    const v = value as { fetchedAt?: number; models?: string[] } | undefined;
    return v?.fetchedAt === undefined ? undefined : { fetchedAt: v.fetchedAt, value: v.models! };
  }
  protected encode(snapshot: ListSnapshot<readonly string[]>): JsonValue {
    return { fetchedAt: snapshot.fetchedAt, models: [...snapshot.value] };
  }
  protected count(value: readonly string[]): number {
    return value.length;
  }
  protected builtin(): readonly string[] | undefined {
    return this.fallback;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ModelListCacheBase", () => {
  test("first use fetches and stores; later reads are answered from memory without a log line", async () => {
    const list = new ScriptedList([["a", "b"]]);
    expect(await list.read()).toEqual({ source: "live", value: ["a", "b"] });
    expect(list.kv.values.get("test/model-catalog")).toEqual({ fetchedAt: T0, models: ["a", "b"] });
    expect(await list.read()).toEqual({ source: "live", value: ["a", "b"] });
    expect(list.calls).toBe(1);
    expect(list.log.lines).toEqual(["INFO test: model list first use: fetching", "INFO test: model list first use → live: 2 models (0 ms)"]);
  });

  test("a fresh stored copy is loaded without a fetch; a stale one is fetched (reason stale)", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set("test/model-catalog", { fetchedAt: T0 - 1000, models: ["saved"] });
    const fresh = new ScriptedList([["live"]], kv);
    expect(await fresh.read()).toEqual({ source: "cache", value: ["saved"] });
    expect(fresh.calls).toBe(0);
    expect(fresh.log.lines).toEqual([`INFO test: model list loaded from the saved copy fetched ${new Date(T0 - 1000).toISOString()}: 1 models`]);

    const stale = new ScriptedList([["live"]], kv, new FixedClock(T0 + MAX_AGE));
    expect(await stale.read()).toEqual({ source: "live", value: ["live"] });
    expect(stale.log.lines[0]).toBe("INFO test: model list stale: fetching");
  });

  test("past the max age a read answers the kept list at once and refreshes it in the background", async () => {
    const list = new ScriptedList([["old"], ["new"]], undefined, undefined, undefined, undefined, true);
    const first = list.read();
    await settle();
    list.release!();
    await first;
    list.time.time += MAX_AGE;
    expect(await list.read()).toEqual({ source: "live", value: ["old"] });
    await settle();
    expect(list.calls).toBe(2);
    expect(await list.read()).toEqual({ source: "live", value: ["old"] });
    expect(list.calls).toBe(2);
    list.release!();
    await settle();
    expect(await list.read()).toEqual({ source: "live", value: ["new"] });
    expect(list.log.lines.at(-1)).toBe("INFO test: model list stale → live: 1 models (0 ms)");
  });

  test("concurrent reads and fetches share one fetch", async () => {
    const list = new ScriptedList([["a"]], undefined, undefined, undefined, undefined, true);
    const reads = [list.read(), list.read(), list.fetch("start")];
    await settle();
    list.release!();
    expect(await Promise.all(reads)).toEqual([0, 1, 2].map(() => ({ source: "live", value: ["a"] })));
    expect(list.calls).toBe(1);
  });

  test("a failed fetch keeps the list in memory and retries in the background no sooner than 60 s later", async () => {
    const list = new ScriptedList([["a"], new Error("getaddrinfo ENOTFOUND"), ["b"]]);
    await list.read();
    expect(await list.fetch("refresh")).toEqual({ source: "cache", value: ["a"] });
    expect(list.log.lines.at(-1)).toBe(`WARN test: model list refresh → failed after 0 ms (getaddrinfo ENOTFOUND) → the list fetched ${new Date(T0).toISOString()}: 1 models`);
    list.time.time += MODEL_LIST_RETRY_MS - 1;
    await list.read();
    expect(list.calls).toBe(2);
    list.time.time += 1;
    expect(await list.read()).toEqual({ source: "live", value: ["a"] });
    await settle();
    expect(list.calls).toBe(3);
    expect(list.log.lines).toContain("INFO test: model list retry: fetching");
    expect(await list.read()).toEqual({ source: "live", value: ["b"] });
  });

  test("a failed fetch falls back to the stored copy of any age, then the built-in list, else fails", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set("test/model-catalog", { fetchedAt: 0, models: ["saved"] });
    const saved = new ScriptedList([new Error("down")], kv);
    expect(await saved.read()).toEqual({ source: "cache", value: ["saved"] });
    expect(saved.log.lines.at(-1)).toBe(`WARN test: model list stale → failed after 0 ms (down) → the saved copy fetched ${new Date(0).toISOString()}: 1 models`);

    const builtin = new ScriptedList([new Error("down")], undefined, undefined, undefined, ["built-in"]);
    expect(await builtin.read()).toEqual({ source: "static", value: ["built-in"] });
    expect(await builtin.fetch("refresh")).toEqual({ source: "static", value: ["built-in"] });
    expect(builtin.log.lines.at(-1)).toBe("WARN test: model list refresh → failed after 0 ms (down) → the built-in list: 1 models");

    const none = new ScriptedList([new Error("down"), ["late"]]);
    await expect(none.read()).rejects.toThrow("down");
    expect(none.log.lines.at(-1)).toBe("WARN test: model list first use → failed after 0 ms (down) → no list");
    expect(await none.read()).toEqual({ source: "live", value: ["late"] });
    expect(none.log.lines.at(-2)).toBe("INFO test: model list retry: fetching");
  });

  test("an unreadable stored copy or a failed write is logged and never fatal", async () => {
    const kv = new MemoryKeyValueStore();
    kv.failRead = new Error("EACCES");
    kv.failWrite = new Error("ENOSPC");
    const list = new ScriptedList([["a"]], kv);
    expect(await list.read()).toEqual({ source: "live", value: ["a"] });
    expect(list.log.lines).toContain("WARN test: model list cache unreadable: Error: EACCES");
    expect(list.log.lines).toContain("WARN test: model list cache write failed: Error: ENOSPC");
  });
});
