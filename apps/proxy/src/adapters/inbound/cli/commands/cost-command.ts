// `cost`: what the exchanges actually cost, from the usage log (plan 2026-11-06-15-21, stages 5 and 6).
import { type CommandHelp, CliCommand, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { FAILED_EXIT, HOME_VARIABLE, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import type { SpendGroupBy } from "@accounts-proxy/core/domain/spend-summary.ts";
import type { SpendQuery, SpendReport, SpendReportPort } from "@accounts-proxy/core/ports/inbound/spend.ts";

/** A budget ceiling was crossed; `3` already means "tier incomplete" in `scripts/gate/run-tests.ts`. */
export const BUDGET_EXIT = 4;

export const COST_HELP: CommandHelp = {
  name: "cost",
  synopsis: ["cost [--day <date>] [--since <date>] [--until <date>] [--by <group>] [--json] [--reconcile] [--watch <seconds>] [--budget-daily <usd>] [--budget-monthly <usd>]"],
  summary: "what the exchanges of the usage log actually cost",
  description: [
    "Totals the usage log's exchange records — the upstream's own charge, not a catalogue estimate — as dollars, dollars per million output tokens and cache share, with one row per provider by default.",
    "`--day` selects a local calendar day; `--since`/`--until` take ISO dates and default to today. `--by` groups by provider, model or day. When retention has removed files the window needs, the report says `partial` and prints the range it could read.",
    "`--watch` repeats the report every N seconds and exits 4 the first time a budget is crossed; `--reconcile` prints OpenCode's own estimate beside the actual charge.",
  ],
  options: [
    { name: "--day <date>", text: "one local calendar day, YYYY-MM-DD (default: today)" },
    { name: "--since <date>", text: "window start, YYYY-MM-DD, inclusive" },
    { name: "--until <date>", text: "window end, YYYY-MM-DD, exclusive" },
    { name: "--by <group>", text: "provider, model or day (default: provider)" },
    { name: "--json", text: "the report as JSON" },
    { name: "--reconcile", text: "print `opencode stats`' estimate beside the actual charge" },
    { name: "--watch <seconds>", text: "repeat every N seconds; exit 4 when a budget is crossed" },
    { name: "--budget-daily <usd>", text: "daily ceiling for --watch" },
    { name: "--budget-monthly <usd>", text: "monthly ceiling for --watch" },
  ],
  exits: [{ name: "0", text: "the report was printed" }, FAILED_EXIT, USAGE_EXIT, { name: `${BUDGET_EXIT}`, text: "a budget ceiling was crossed" }],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy cost", text: "today's spend, by provider" },
    { name: "bun run proxy cost --day 2026-11-06 --by model --json", text: "one day's spend per model, as JSON" },
    { name: "bun run proxy cost --since 2026-11-01 --by day", text: "the month so far, one row per day" },
    { name: "bun run proxy cost --watch 300 --budget-daily 5 --budget-monthly 60", text: "a status line every 5 minutes until a ceiling is crossed" },
    { name: "bun run proxy cost --reconcile", text: "the actual charge beside OpenCode's estimate" },
  ],
};

export type ReconcileOutcome = { readonly estimate: number; readonly days: number } | { readonly skipped: "not-found" | "timed-out" | "unreadable" };

/** What the command needs from the world beyond the spend port; tests replace every member. */
export type CostSeams = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly reconcile: (days: number) => Promise<ReconcileOutcome>;
  readonly notify: (title: string, body: string) => void;
};

const DAY = 86_400_000;

const NUMBER = /^\d+(?:\.\d+)?$/;

/** Reads one flag's value, refusing a missing or malformed one. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`cost: ${flag} needs a value`);
  return value;
}

function dateOf(word: string, flag: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(word) || Number.isNaN(Date.parse(`${word}T00:00:00`))) {
    throw new UsageError(`cost: ${flag} needs a date, YYYY-MM-DD`);
  }
  return Date.parse(`${word}T00:00:00`);
}

function groupOf(word: string | undefined): SpendGroupBy {
  if (word === undefined) return "provider";
  if (word !== "provider" && word !== "model" && word !== "day") throw new UsageError("cost: --by needs provider, model or day");
  return word;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function perMillion(value: number): string {
  return `$${value.toFixed(3)}/M`;
}

function human(report: SpendReport): string {
  const { totals, groups } = report.summary;
  const iso = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `window   ${iso(report.window.from)} → ${iso(report.window.until)} (${report.coverage}${report.coverage === "partial" ? `, read ${iso(report.covered.from)} → ${iso(report.covered.until)}` : ""})`,
    `cost     ${money(totals.cost)}`,
    `exchanges ${`${totals.exchanges}`}`,
    `output   ${totals.outputTokens} tokens`,
    `per M    ${perMillion(totals.perMillionOutput)}`,
    `cache    ${(totals.cacheShare * 100).toFixed(1)}%`,
    `malformed ${`${report.malformed}`}`,
  ];
  if (groups.length > 0) lines.push(`by group (${groups.length}):`);
  for (const group of groups) lines.push(`  ${group.key.padEnd(40)} ${money(group.totals.cost)}  ${group.totals.exchanges} exchanges  ${perMillion(group.totals.perMillionOutput)}`);
  return `${lines.join("\n")}\n`;
}

export class CostCommand extends CliCommand {
  readonly help = COST_HELP;

  constructor(
    private readonly spend: SpendReportPort,
    private readonly seams: CostSeams,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<number | void> {
    const query = this.queryOf(args);
    const json = args.includes("--json");
    const reconcile = args.includes("--reconcile");
    const watch = valueOf(args, "--watch");
    const daily = this.budgetOf(args, "--budget-daily");
    const monthly = this.budgetOf(args, "--budget-monthly");
    if (watch === undefined) {
      const report = await this.spend.report(query);
      out(json ? `${JSON.stringify(report, null, 2)}\n` : human(report));
      if (reconcile) out(await this.reconciled(query, this.seams.now(), report.summary.totals.cost));
      return;
    }
    if (!NUMBER.test(watch)) throw new UsageError("cost: --watch needs a number of seconds");
    return this.watch(Number(watch) * 1000, query, { ...(daily === undefined ? {} : { daily }), ...(monthly === undefined ? {} : { monthly }) }, out);
  }

  private queryOf(args: readonly string[]): SpendQuery {
    const known = ["--json", "--reconcile"];
    const valued = ["--day", "--since", "--until", "--by", "--watch", "--budget-daily", "--budget-monthly"];
    for (let at = 0; at < args.length; at += 1) {
      const word = args[at] as string;
      if (known.includes(word)) continue;
      if (!valued.includes(word)) throw new UsageError(`cost: unknown option ${word}`);
      at += 1;
    }
    const day = valueOf(args, "--day");
    const since = valueOf(args, "--since");
    const until = valueOf(args, "--until");
    if (day !== undefined) dateOf(day, "--day");
    return {
      by: groupOf(valueOf(args, "--by")),
      ...(day === undefined ? {} : { day }),
      ...(since === undefined ? {} : { since: dateOf(since, "--since") }),
      ...(until === undefined ? {} : { until: dateOf(until, "--until") }),
    };
  }

  private budgetOf(args: readonly string[], flag: string): number | undefined {
    const word = valueOf(args, flag);
    if (word === undefined) return undefined;
    if (!NUMBER.test(word)) throw new UsageError(`cost: ${flag} needs a non-negative number`);
    return Number(word);
  }

  private async watch(intervalMs: number, query: SpendQuery, budgets: { daily?: number; monthly?: number }, out: Writer): Promise<number> {
    for (;;) {
      const report = await this.spend.report(query);
      const month = await this.spend.report({ by: "provider", since: monthStart(this.seams.now()), until: this.seams.now() });
      const at = new Date(this.seams.now());
      const clock = `${`${at.getHours()}`.padStart(2, "0")}:${`${at.getMinutes()}`.padStart(2, "0")}`;
      const line = `${clock} ${money(report.summary.totals.cost)} today · ${money(month.summary.totals.cost)} month · cache ${(report.summary.totals.cacheShare * 100).toFixed(1)}%${report.coverage === "partial" ? " (partial)" : ""}`;
      out(`${line}\n`);
      const breached = this.breach(report.summary.totals.cost, month.summary.totals.cost, budgets);
      if (breached !== undefined) {
        this.seams.notify("accounts-proxy budget", breached);
        out(`${breached}\n`);
        return BUDGET_EXIT;
      }
      await this.seams.sleep(intervalMs);
    }
  }

  private breach(daily: number, monthly: number, budgets: { daily?: number; monthly?: number }): string | undefined {
    if (budgets.daily !== undefined && daily > budgets.daily) return `budget breached: ${money(daily)} today > ${money(budgets.daily)}`;
    if (budgets.monthly !== undefined && monthly > budgets.monthly) return `budget breached: ${money(monthly)} this month > ${money(budgets.monthly)}`;
    return undefined;
  }

  private async reconciled(query: SpendQuery, now: number, actual: number): Promise<string> {
    const since = query.day !== undefined ? dateOf(query.day, "--day") : (query.since ?? now - DAY);
    const days = Math.max(1, Math.ceil((now - since) / DAY));
    const outcome = await this.seams.reconcile(days);
    if ("skipped" in outcome) return `reconciliation skipped: ${outcome.skipped}\n`;
    const delta = actual === 0 ? 0 : ((outcome.estimate - actual) / actual) * 100;
    return `estimate opencode ${money(outcome.estimate)} · actual upstream ${money(actual)} · delta ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%\n`;
  }
}

/** Local midnight of the first day of the month containing `at`. */
function monthStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}
