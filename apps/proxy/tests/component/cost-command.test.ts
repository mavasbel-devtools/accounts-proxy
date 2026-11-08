// `cost` rendering and parsing (plan 2026-11-06-15-21, stages 5 and 6): the human table, JSON, reconciliation, every
// usage error, and the daily grouping flag — over a scripted spend port.
import { describe, expect, test } from "bun:test";
import { CostCommand, type CostSeams, type ReconcileOutcome } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/cost-command.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { CommandRoot } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { PROGRAM } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import { SpendReportPort, type SpendQuery, type SpendReport } from "@accounts-proxy/core/ports/inbound/spend.ts";

const NOW = Date.parse("2026-11-06T15:00:00");
const DAY = 86_400_000;

type Script = { readonly cost?: number; readonly coverage?: "complete" | "partial"; readonly groups?: SpendReport["summary"]["groups"] };

class ScriptedSpend extends SpendReportPort {
  asked: SpendQuery[] = [];
  constructor(private readonly script: Script = {}) {
    super();
  }
  async report(query: SpendQuery): Promise<SpendReport> {
    this.asked.push(query);
    const from = Date.parse("2026-11-06T00:00:00");
    const cost = this.script.cost ?? 0.2943;
    const totals = { cost, promptTokens: 1_000_000, outputTokens: 193_317, cachedTokens: 951_000, perMillionOutput: 1.5224, cacheShare: 0.951, exchanges: 432 };
    const groups = this.script.groups ?? [{ key: "DeepInfra", totals }];
    return {
      window: { from, until: from + DAY },
      coverage: this.script.coverage ?? "partial",
      covered: { from: from + 3_600_000, until: from + DAY },
      malformed: 2,
      summary: { totals, groups },
    };
  }
}

function seams(over: Partial<CostSeams> = {}): CostSeams & { notes: string[] } {
  const notes: string[] = [];
  return { now: () => NOW, sleep: async () => undefined, reconcile: async () => ({ skipped: "not-found" }), notify: (title, body) => notes.push(`${title}: ${body}`), ...over, notes };
}

function cli(spend: ScriptedSpend, s: CostSeams) {
  const out: string[] = [];
  const err: string[] = [];
  const driver = new CommandLineDriver(new CommandRoot({ name: "", synopsis: [], summary: "", description: [], exits: [], examples: [] }, [new CostCommand(spend, s)]), PROGRAM, (t) => out.push(t), (t) => err.push(t));
  return { out, err, run: (...argv: string[]) => driver.run(argv) };
}

describe("cost", () => {
  test("uc-1: the human report names the window, the cost, the price per million and the group row", async () => {
    const c = cli(new ScriptedSpend(), seams());
    expect(await c.run("cost")).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("$0.2943");
    expect(text).toContain("$1.522/M");
    expect(text).toContain("95.1%");
    expect(text).toContain("partial, read");
    expect(text).toContain("DeepInfra");
  });

  test("uc-1: a complete window with no groups prints neither the read range nor a group section", async () => {
    const c = cli(new ScriptedSpend({ coverage: "complete", groups: [] }), seams());
    expect(await c.run("cost")).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("(complete)");
    expect(text).not.toContain("by group");
  });

  test("uc-2: --json prints the report shape and --by day reaches the port", async () => {
    const spend = new ScriptedSpend();
    const c = cli(spend, seams());
    expect(await c.run("cost", "--day", "2026-11-06", "--by", "day", "--json")).toBe(0);
    const parsed = JSON.parse(c.out.join("")) as SpendReport;
    expect(parsed.summary.totals.exchanges).toBe(432);
    expect(spend.asked[0]).toEqual({ day: "2026-11-06", by: "day" });
  });

  test("uc-2 negative: an impossible date and an unknown option are usage errors with nothing on stdout", async () => {
    const c = cli(new ScriptedSpend(), seams());
    expect(await c.run("cost", "--day", "2026-13-40")).toBe(2);
    expect(await c.run("cost", "--bogus")).toBe(2);
    expect(await c.run("cost", "--by", "week")).toBe(2);
    expect(await c.run("cost", "--watch")).toBe(2);
    expect(await c.run("cost", "--watch", "soon")).toBe(2);
    expect(c.out).toEqual([]);
  });

  test("uc-4: --reconcile prints the estimate, the actual and a positive delta", async () => {
    const outcome: ReconcileOutcome = { estimate: 2.35, days: 1 };
    const c = cli(new ScriptedSpend(), seams({ reconcile: async () => outcome }));
    expect(await c.run("cost", "--reconcile")).toBe(0);
    expect(c.out.join("")).toContain("estimate opencode $2.3500");
    expect(c.out.join("")).toContain("actual upstream $0.2943");
    expect(c.out.join("")).toContain("delta +");
  });

  test("uc-4: a negative delta is signed, and a window with no spend reports 0 % instead of dividing by zero", async () => {
    const c = cli(new ScriptedSpend({ cost: 3 }), seams({ reconcile: async () => ({ estimate: 1.5, days: 1 }) }));
    expect(await c.run("cost", "--reconcile", "--day", "2026-11-06")).toBe(0);
    expect(c.out.join("")).toContain("delta -50.0%");

    const zero = cli(new ScriptedSpend({ cost: 0 }), seams({ reconcile: async () => ({ estimate: 1, days: 1 }) }));
    expect(await zero.run("cost", "--reconcile")).toBe(0);
    expect(zero.out.join("")).toContain("delta +0.0%");
  });

  test("uc-4 negative: a skipped reconciliation still reports the spend and exits 0", async () => {
    const c = cli(new ScriptedSpend(), seams({ reconcile: async () => ({ skipped: "not-found" }) }));
    expect(await c.run("cost", "--reconcile")).toBe(0);
    expect(c.out.join("")).toContain("reconciliation skipped: not-found");
  });

  test("uc-2: --since/--until reach the port as epoch milliseconds", async () => {
    const spend = new ScriptedSpend();
    const c = cli(spend, seams());
    expect(await c.run("cost", "--since", "2026-11-01", "--until", "2026-11-06")).toBe(0);
    expect(spend.asked[0]).toEqual({ since: Date.parse("2026-11-01T00:00:00"), until: Date.parse("2026-11-06T00:00:00"), by: "provider" });
  });

  test("uc-1: --until alone leaves the start to the service", async () => {
    const spend = new ScriptedSpend();
    const c = cli(spend, seams());
    expect(await c.run("cost", "--until", "2026-11-06")).toBe(0);
    expect(spend.asked[0]).toEqual({ until: Date.parse("2026-11-06T00:00:00"), by: "provider" });
  });
});
