// The spend arithmetic (plan 2026-11-06-15-21, stage 2): every branch of summarizeSpend, including the zero-output and
// zero-prompt cases and the entry the log could not have produced.
import { describe, expect, test } from "bun:test";
import { EMPTY_TOTALS, InvalidSpendEntryError, summarizeSpend, type SpendEntry } from "@accounts-proxy/core/domain/spend-summary.ts";

const entry = (over: Partial<SpendEntry> = {}): SpendEntry => ({
  at: Date.parse("2026-11-06T10:00:00Z"),
  provider: "DeepInfra",
  model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  cost: 0.1,
  promptTokens: 1000,
  outputTokens: 1000,
  cachedTokens: 500,
  ...over,
});

describe("summarizeSpend", () => {
  test("an empty window is all zeros, not a division by zero", () => {
    expect(summarizeSpend([], "provider")).toEqual({ totals: EMPTY_TOTALS, groups: [] });
  });

  test("one entry: cost, both derived figures and the exchange count", () => {
    const summary = summarizeSpend([entry()], "provider");
    expect(summary.totals.cost).toBeCloseTo(0.1, 10);
    expect(summary.totals.perMillionOutput).toBeCloseTo(100, 10);
    expect(summary.totals.cacheShare).toBeCloseTo(0.5, 10);
    expect(summary.totals.exchanges).toBe(1);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.key).toBe("DeepInfra");
  });

  test("no output tokens: perMillionOutput is 0 rather than NaN", () => {
    expect(summarizeSpend([entry({ outputTokens: 0 })], "provider").totals.perMillionOutput).toBe(0);
  });

  test("no prompt tokens: cacheShare is 0 rather than NaN", () => {
    expect(summarizeSpend([entry({ promptTokens: 0, cachedTokens: 0 })], "provider").totals.cacheShare).toBe(0);
  });

  test("cacheShare 1 when every prompt token was cached", () => {
    expect(summarizeSpend([entry({ promptTokens: 10, cachedTokens: 10 })], "provider").totals.cacheShare).toBe(1);
  });

  test("groups by provider, model and UTC day, ordered by cost then key", () => {
    const entries = [
      entry({ provider: "OpenAI", model: "m-b", cost: 0.2 }),
      entry({ provider: "DeepInfra", model: "m-a", cost: 0.2 }),
      entry({ provider: "DeepInfra", model: "m-a", cost: 0.05, at: Date.parse("2026-11-05T23:59:59Z") }),
    ];
    expect(summarizeSpend(entries, "provider").groups.map((g) => g.key)).toEqual(["DeepInfra", "OpenAI"]);
    expect(summarizeSpend(entries, "model").groups.map((g) => g.key)).toEqual(["m-a", "m-b"]);
    expect(summarizeSpend(entries, "day").groups.map((g) => g.key)).toEqual(["2026-11-06", "2026-11-05"]);
  });

  test("equal costs are ordered by key, ascending in both directions", () => {
    expect(summarizeSpend([entry({ provider: "b" }), entry({ provider: "a" })], "provider").groups.map((g) => g.key)).toEqual(["a", "b"]);
    expect(summarizeSpend([entry({ provider: "a" }), entry({ provider: "b" })], "provider").groups.map((g) => g.key)).toEqual(["a", "b"]);
    expect(summarizeSpend([entry({ provider: "b" }), entry({ provider: "a" }), entry({ provider: "c" })], "provider").groups.map((g) => g.key)).toEqual(["a", "b", "c"]);
  });

  test("rejects an entry whose cached tokens exceed its prompt tokens", () => {
    expect(() => summarizeSpend([entry({ promptTokens: 10, cachedTokens: 11 })], "provider")).toThrow(InvalidSpendEntryError);
  });
});
