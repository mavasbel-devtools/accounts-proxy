// The spend report service (plan 2026-11-06-15-21, stage 4): window resolution, the partial/complete distinction and
// the one negative case each use case needs.
import { describe, expect, test } from "bun:test";
import { SpendReportService } from "@accounts-proxy/proxy/application/spend-report-service.ts";
import { SpendLogPort, type SpendLogRead } from "@accounts-proxy/core/ports/outbound/spend-log.ts";
import type { SpendWindow } from "@accounts-proxy/core/domain/spend-summary.ts";

/** A log that answers with a fixed read and remembers the window it was asked for. */
class ScriptedLog extends SpendLogPort {
  asked: SpendWindow[] = [];
  constructor(private answer: SpendLogRead) {
    super();
  }
  async read(window: SpendWindow): Promise<SpendLogRead> {
    this.asked.push(window);
    return this.answer;
  }
}

const NOW = Date.parse("2026-11-06T15:00:00");

const entry = (at: number, cost: number) => ({ at, provider: "DeepInfra", model: "m", cost, promptTokens: 100, outputTokens: 100, cachedTokens: 90 });

describe("SpendReportService", () => {
  test("uc-1: no query is today, complete when the log starts at or before midnight", async () => {
    const from = Date.parse("2026-11-06T00:00:00");
    const log = new ScriptedLog({ entries: [entry(from + 3_600_000, 0.25)], malformed: 0, covered: { from, until: NOW } });
    const report = await new SpendReportService(log, () => NOW).report({ by: "provider" });
    expect(report.window.from).toBe(from);
    expect(report.coverage).toBe("complete");
    expect(report.summary.totals.cost).toBeCloseTo(0.25, 10);
  });

  test("uc-1 negative: an empty log reports zeros and a complete empty window", async () => {
    const report = await new SpendReportService(new ScriptedLog({ entries: [], malformed: 0, covered: undefined }), () => NOW).report({ by: "provider" });
    expect(report.summary.totals).toEqual({ cost: 0, promptTokens: 0, outputTokens: 0, cachedTokens: 0, perMillionOutput: 0, cacheShare: 0, exchanges: 0 });
    expect(report.coverage).toBe("complete");
    expect(report.covered).toEqual({ from: report.window.from, until: report.window.from });
  });

  test("uc-2: an explicit day is one local calendar day, grouped as asked", async () => {
    const log = new ScriptedLog({ entries: [entry(Date.parse("2026-11-06T10:00:00"), 0.5)], malformed: 0, covered: { from: Date.parse("2026-11-01T00:00:00"), until: NOW } });
    const report = await new SpendReportService(log, () => NOW).report({ day: "2026-11-06", by: "model" });
    expect(report.window).toEqual({ from: Date.parse("2026-11-06T00:00:00"), until: Date.parse("2026-11-07T00:00:00") });
    expect(log.asked[0]).toEqual(report.window);
    expect(report.summary.groups.map((g) => g.key)).toEqual(["m"]);
  });

  test("uc-3: a log that starts after the window start is partial, with the covered span", async () => {
    const covered = { from: Date.parse("2026-11-04T00:00:00"), until: NOW };
    const log = new ScriptedLog({ entries: [], malformed: 3, covered });
    const report = await new SpendReportService(log, () => NOW).report({ since: Date.parse("2026-11-01T00:00:00"), by: "day" });
    expect(report.coverage).toBe("partial");
    expect(report.covered).toEqual(covered);
    expect(report.malformed).toBe(3);
  });

  test("uc-3 negative: since/until pass through unchanged when both are given", async () => {
    const since = Date.parse("2026-11-02T00:00:00");
    const until = Date.parse("2026-11-03T00:00:00");
    const log = new ScriptedLog({ entries: [], malformed: 0, covered: { from: since, until } });
    const report = await new SpendReportService(log, () => NOW).report({ since, until, by: "provider" });
    expect(log.asked[0]).toEqual({ from: since, until });
    expect(report.coverage).toBe("complete");
  });
});
