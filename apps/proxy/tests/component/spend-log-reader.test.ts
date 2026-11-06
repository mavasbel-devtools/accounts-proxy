// The usage log as spend (plan 2026-11-06-15-21, stage 3): real files from the fixtures, a malformed line, a refused
// exchange, a missing provider, and a directory that does not exist.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SpendLogReader } from "@accounts-proxy/proxy/adapters/outbound/spend-log-reader.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "spend");
const day = (date: string) => ({ from: Date.parse(`${date}T00:00:00`), until: Date.parse(`${date}T00:00:00`) + 86_400_000 });

describe("SpendLogReader", () => {
  test("reads one day: cost, tokens, model, provider, malformed count and the covered span", async () => {
    const read = await new SpendLogReader(fixtures).read(day("2026-11-06"));
    expect(read.entries).toHaveLength(2);
    expect(read.entries.reduce((sum, e) => sum + e.cost, 0)).toBeCloseTo(0.75, 10);
    expect(read.entries[0]?.model).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(read.entries[0]?.provider).toBe("DeepInfra");
    expect(read.entries[1]?.provider).toBe("unknown");
    expect(read.malformed).toBe(2);
    expect(read.covered).toEqual({ from: Date.parse("2026-11-05T00:00:00"), until: Date.parse("2026-11-07T00:00:00") });
  });

  test("a window that excludes the entries returns the span of the files it read", async () => {
    const read = await new SpendLogReader(fixtures).read({ from: Date.parse("2026-11-04T00:00:00"), until: Date.parse("2026-11-05T00:00:00") });
    expect(read.entries).toEqual([]);
    expect(read.covered).toEqual({ from: Date.parse("2026-11-05T00:00:00"), until: Date.parse("2026-11-07T00:00:00") });
  });

  test("a sub-day window keeps only the entries inside it and still counts the file's malformed lines", async () => {
    const read = await new SpendLogReader(fixtures).read({ from: Date.parse("2026-11-06T12:00:00"), until: Date.parse("2026-11-06T13:00:00") });
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.cost).toBeCloseTo(0.25, 10);
    expect(read.malformed).toBe(2);
  });

  test("a directory that does not exist reads as empty, not as an error", async () => {
    expect(await new SpendLogReader(join(fixtures, "absent")).read(day("2026-11-06"))).toEqual({ entries: [], malformed: 0, covered: undefined });
  });

  test("a record without a body, one with no token details and a refused exchange", async () => {
    const read = await new SpendLogReader(join(fixtures, "..", "spend-edge")).read(day("2026-11-07"));
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.model).toBe("unknown");
    expect(read.entries[0]?.provider).toBe("unknown");
    expect(read.entries[0]?.promptTokens).toBe(0);
    expect(read.entries[0]?.outputTokens).toBe(0);
    expect(read.entries[0]?.cachedTokens).toBe(0);
    expect(read.malformed).toBe(0);
  });

  test("a blank line, a request record, a body with only a provider and a record without a timestamp", async () => {
    const read = await new SpendLogReader(join(fixtures, "..", "spend-edge")).read(day("2026-11-08"));
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.model).toBe("unknown");
    expect(read.entries[0]?.provider).toBe("DeepInfra");
    expect(read.malformed).toBe(1);
  });

  test("a second read of an unchanged file answers the same from the cache", async () => {
    const reader = new SpendLogReader(fixtures);
    const first = await reader.read(day("2026-11-06"));
    const second = await reader.read(day("2026-11-06"));
    expect(second).toEqual(first);
  });

  test("a logs directory with only a proxy log has no covered span", async () => {
    const read = await new SpendLogReader(join(fixtures, "..", "spend-edge", "empty")).read(day("2026-11-06"));
    expect(read).toEqual({ entries: [], malformed: 0, covered: undefined });
  });
});
