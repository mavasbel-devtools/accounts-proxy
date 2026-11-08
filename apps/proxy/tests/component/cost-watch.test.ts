// `cost --watch` (plan 2026-11-06-15-21, uc-5): the tick line, the daily and monthly ceilings, the exit code and the
// notification, with the clock, the sleep and the notifier all replaced.
import { describe, expect, test } from "bun:test";
import { BUDGET_EXIT, CostCommand, type CostSeams } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/cost-command.ts";
import { SpendReportPort, type SpendQuery, type SpendReport } from "@accounts-proxy/core/ports/inbound/spend.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { PROGRAM } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import { CommandRoot } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";

const NOW = Date.parse("2026-11-06T15:00:00");

const totals = (cost: number) => ({ cost, promptTokens: 100, outputTokens: 100, cachedTokens: 90, perMillionOutput: cost === 0 ? 0 : (cost / 100) * 1e6, cacheShare: 0.9, exchanges: cost === 0 ? 0 : 1 });

/** Answers with the next scripted cost, one per call, remembering every query. */
class ScriptedSpend extends SpendReportPort {
  asked: SpendQuery[] = [];
  constructor(
    private readonly costs: readonly number[],
    private readonly coverage: "complete" | "partial" = "complete",
  ) {
    super();
  }
  async report(query: SpendQuery): Promise<SpendReport> {
    this.asked.push(query);
    const cost = this.costs[Math.min(this.asked.length - 1, this.costs.length - 1)] ?? 0;
    const from = query.since ?? Date.parse("2026-11-06T00:00:00");
    return {
      window: { from, until: NOW },
      coverage: this.coverage,
      covered: { from, until: NOW },
      malformed: 0,
      summary: { totals: totals(cost), groups: [] },
    };
  }
}

/** A sleep that records its calls and never waits. */
function seams(over: Partial<CostSeams> = {}): CostSeams & { slept: number[]; notes: string[] } {
  const slept: number[] = [];
  const notes: string[] = [];
  return {
    now: () => NOW,
    sleep: async (ms) => {
      slept.push(ms);
    },
    reconcile: async () => ({ skipped: "not-found" }),
    notify: (title, body) => notes.push(`${title}: ${body}`),
    ...over,
    slept,
    notes,
  };
}

function cli(spend: ScriptedSpend, s: CostSeams) {
  const out: string[] = [];
  const driver = new CommandLineDriver(new CommandRoot({ name: "", synopsis: [], summary: "", description: [], exits: [], examples: [] }, [new CostCommand(spend, s)]), PROGRAM, (t) => out.push(t), () => undefined);
  return { out, run: (...argv: string[]) => driver.run(argv) };
}

describe("cost --watch", () => {
  test("uc-5: ticks once per interval and exits 4 when the daily ceiling is crossed", async () => {
    const spend = new ScriptedSpend([1, 6]);
    const s = seams();
    const c = cli(spend, s);
    expect(await c.run("cost", "--watch", "30", "--budget-daily", "5")).toBe(BUDGET_EXIT);
    expect(s.slept).toEqual([30_000]);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toContain("budget breached");
    expect(c.out.join("")).toContain("today");
  });

  test("uc-5 negative: a malformed budget is a usage error, not a ceiling of zero", async () => {
    const c = cli(new ScriptedSpend([0]), seams());
    expect(await c.run("cost", "--watch", "30", "--budget-daily", "five")).toBe(2);
  });

  test("uc-5: a tick under every ceiling prints a partial line and keeps watching", async () => {
    const spend = new ScriptedSpend([0.1], "partial");
    const stop = new Error("stop the loop");
    let ticks = 0;
    const s = seams({
      sleep: async () => {
        ticks += 1;
        if (ticks === 1) throw stop;
      },
    });
    const c = cli(spend, s);
    expect(await c.run("cost", "--watch", "1", "--budget-daily", "5")).toBe(1);
    expect(c.out.join("")).toContain("(partial)");
    expect(c.out.join("")).toContain("today");
  });

  test("uc-5: the monthly ceiling is read from the first of the month and can be the one that trips", async () => {
    const spend = new ScriptedSpend([0.1, 100]);
    const s = seams();
    const c = cli(spend, s);
    expect(await c.run("cost", "--watch", "1", "--budget-monthly", "50")).toBe(BUDGET_EXIT);
    expect(spend.asked[1]?.since).toBe(new Date(2026, 10, 1).getTime());
    expect(s.notes[0]).toContain("this month");
  });
});
