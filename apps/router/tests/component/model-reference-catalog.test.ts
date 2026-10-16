// The reference model catalog adapter (plan 2026-10-16 rule M4): live, the stored copy for 24 h, the built-in copy.
import { describe, expect, test } from "bun:test";
import { BUILTIN_REFERENCE } from "@inference-router/router/adapters/outbound/builtin-model-reference.ts";
import { MODEL_REFERENCE_URL, ModelReferenceCatalog, REFERENCE_TIMEOUT_MS, REFERENCE_TTL_MS } from "@inference-router/router/adapters/outbound/model-reference-catalog.ts";
import { FixedClock, MemoryKeyValueStore, MemoryLogger, ScriptedTransport, type ScriptedResponse } from "@inference-router/test-support/fakes.ts";

const DOC = JSON.stringify({ anthropic: { npm: "@ai-sdk/anthropic", models: { c: { name: "C" } } }, other: { models: {} } });
const BUILTIN = { google: { g: { name: "G" } } };

const make = (handler: (i: number) => ScriptedResponse, store = new MemoryKeyValueStore()) => {
  const transport = new ScriptedTransport((_, i) => handler(i));
  const clock = new FixedClock();
  const logger = new MemoryLogger();
  return { transport, clock, logger, store, catalog: new ModelReferenceCatalog(transport, store, clock, logger, "http://gw/api.json", BUILTIN) };
};

describe("ModelReferenceCatalog", () => {
  test("live, then memory for 24 h, then a refresh; the parsed copy is stored", async () => {
    const m = make(() => ({ status: 200, body: DOC }));
    const a = await m.catalog.reference();
    expect(a.source).toBe("live");
    expect([...a.catalog.keys()]).toEqual(["anthropic"]);
    expect(a.catalog.get("anthropic")!.get("c")).toEqual({ name: "C", aiSdkPackage: "@ai-sdk/anthropic" });
    expect(m.transport.requests).toEqual([{ method: "GET", url: "http://gw/api.json", headers: { accept: "application/json" }, timeoutMs: REFERENCE_TIMEOUT_MS }]);
    expect(m.store.values.get("model-reference")).toEqual({ version: 1, fetchedAt: m.clock.time, catalog: { anthropic: { c: { name: "C", aiSdkPackage: "@ai-sdk/anthropic" } } } });
    expect((await m.catalog.reference()).source).toBe("live");
    expect(m.transport.requests).toHaveLength(1);
    m.clock.time += REFERENCE_TTL_MS;
    await m.catalog.reference();
    expect(m.transport.requests).toHaveLength(2);
  });

  test("a fresh stored copy is used without a read; a stale one is the fallback when the read fails; else the built-in copy", async () => {
    const store = new MemoryKeyValueStore();
    store.values.set("model-reference", { version: 1, fetchedAt: 1_800_000_000_000, catalog: { openai: { o: { name: "O" } } } });
    const fresh = make(() => ({ status: 500 }), store);
    expect((await fresh.catalog.reference()).source).toBe("cache");
    expect(fresh.transport.requests).toHaveLength(0);
    store.values.set("model-reference", { version: 1, fetchedAt: 0, catalog: { openai: { o: { name: "O" } } } });
    const stale = make(() => ({ status: 503, body: "down" }), store);
    const fallback = await stale.catalog.reference();
    expect([fallback.source, fallback.catalog.get("openai")!.get("o")]).toEqual(["cache", { name: "O" }]);
    expect(stale.logger.lines).toEqual(["WARN model reference: http://gw/api.json unavailable (GET http://gw/api.json HTTP 503)"]);
    const empty = make(() => ({ status: 200, body: JSON.stringify({ nope: {} }) }));
    const builtin = await empty.catalog.reference();
    expect([builtin.source, builtin.catalog.get("google")!.get("g")]).toEqual(["static", { name: "G" }]);
    expect(empty.logger.lines).toEqual(["WARN model reference: http://gw/api.json unavailable (GET http://gw/api.json: no reference provider in the document)"]);
  });

  test("cache faults are warned, never fatal; a malformed stored copy is ignored", async () => {
    const store = new MemoryKeyValueStore();
    store.failRead = new Error("disk");
    store.failWrite = new Error("full");
    const m = make(() => ({ status: 200, body: DOC }), store);
    expect((await m.catalog.reference()).source).toBe("live");
    expect(m.logger.lines).toEqual(["WARN model reference: cache unreadable: Error: disk", "WARN model reference: cache write failed: Error: full"]);
    for (const bad of [null, [], { version: 2, fetchedAt: 1, catalog: {} }, { version: 1, fetchedAt: "1", catalog: {} }, { version: 1, fetchedAt: 1, catalog: null }, { version: 1, fetchedAt: 1, catalog: [] }]) {
      const s = new MemoryKeyValueStore();
      s.values.set("model-reference", bad);
      expect((await make(() => ({ status: 200, body: "not json" }), s).catalog.reference()).source).toBe("static");
    }
  });

  test("the production address and the built-in copy (generated from the committed extract)", () => {
    expect(MODEL_REFERENCE_URL).toBe("https://models.opencode.ai/api.json");
    expect(Object.keys(BUILTIN_REFERENCE)).toEqual(["anthropic", "google", "openai", "openrouter", "opencode", "opencode-go"]);
  });
});
