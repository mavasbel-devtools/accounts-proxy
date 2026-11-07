// `cost`, black-box (plan 2026-11-06-15-21, stages 5 and 6): a real process, a real home, a usage log the reader finds.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { logsDir, makeHome, runProxy, spawnProxyRunning, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

let home: Home | undefined;
afterEach(() => {
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});

const exchange = (at: string, cost: number) =>
  `${JSON.stringify({
    schema: "accounts-proxy-exchange/1",
    at,
    kind: "client-response",
    status: 200,
    body: { text: 'data: {"model":"deepseek/deepseek-v4.1-flash-1017","provider":"DeepInfra","choices":[]}\n\n' },
    usage: { raw: { cost }, tokens: { input: 1000, output: 100, cacheRead: 900 } },
  })}\n`;

describe("cost", () => {
  test("uc-1/uc-2: reports the day's exchanges from the home's usage log, as JSON and as text", async () => {
    home = await makeHome();
    mkdirSync(logsDir(home), { recursive: true });
    writeFileSync(join(logsDir(home), "2026-11-06-1-usage.1.jsonl"), exchange("2026-11-06T10:00:00.000Z", 0.5) + exchange("2026-11-06T11:00:00.000Z", 0.25));
    const json = await runProxy(home, ["cost", "--day", "2026-11-06", "--json"]);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as { summary: { totals: { cost: number; exchanges: number } }; coverage: string };
    expect(report.summary.totals.cost).toBeCloseTo(0.75, 10);
    expect(report.summary.totals.exchanges).toBe(2);
    expect(report.coverage).toBe("complete");

    const text = await runProxy(home, ["cost", "--day", "2026-11-06"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("$0.7500");
    expect(text.stdout).toContain("DeepInfra");
  });

  test("uc-1 negative: a home with no logs reports zeros and exits 0", async () => {
    home = await makeHome();
    const result = await runProxy(home, ["cost"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("$0.0000");
  });

  test("uc-2 negative: an unknown option is a usage error with the usage on stderr", async () => {
    home = await makeHome();
    const result = await runProxy(home, ["cost", "--bogus"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage");
  });

  test("the help names the command and its exit codes", async () => {
    home = await makeHome();
    const result = await runProxy(home, ["help", "cost"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("bun run proxy cost");
    expect(result.stdout).toContain("--budget-daily");
  });
});

/** A usage record; every field but the kind is optional, so the reader's "absent" paths are reachable too. */
const record = (fields: Record<string, unknown>) => `${JSON.stringify(fields)}\n`;

const body = (model: string | undefined, provider: string | undefined) =>
  model === undefined && provider === undefined
    ? undefined
    : { text: `data: ${JSON.stringify({ ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }), choices: [] })}\n\n` };

const exchangeOf = (fields: {
  at?: string;
  status?: number;
  kind?: string;
  model?: string;
  provider?: string;
  cost?: number;
  tokens?: Record<string, number>;
  noBody?: boolean;
}) =>
  record({
    schema: "accounts-proxy-exchange/1",
    ...(fields.kind === undefined ? { kind: "client-response" } : { kind: fields.kind }),
    ...(fields.at === undefined ? {} : { at: fields.at }),
    status: fields.status ?? 200,
    ...(fields.noBody === true ? {} : { body: body(fields.model, fields.provider) }),
    ...(fields.cost === undefined ? {} : { usage: { raw: { cost: fields.cost }, tokens: fields.tokens ?? { input: 1000, output: 100, cacheRead: 900 } } }),
  });

/** Writes one usage log file into the home; every call uses its own pid, so names never collide. */
let files = 0;
function usageLog(home: Home, day: string, lines: readonly string[]): void {
  mkdirSync(logsDir(home), { recursive: true });
  files += 1;
  writeFileSync(join(logsDir(home), `${day}-${900 + files}-usage.1.jsonl`), lines.join(""));
}

describe("cost, the shapes of the log", () => {
  test("uc-1/uc-2: every grouping, a partial window, and the records the reader has to refuse or count", async () => {
    home = await makeHome();
    usageLog(home, "2026-11-06", [
      exchangeOf({ at: "2026-11-06T10:00:00.000Z", model: "deepseek/deepseek-v4.1-flash-1017", provider: "DeepInfra", cost: 0.5 }),
      // Same cost, different keys: the tie is broken by key, ascending.
      exchangeOf({ at: "2026-11-06T10:30:00.000Z", model: "qwen/qwen3.8-27b", provider: "Google", cost: 0.5 }),
      exchangeOf({ at: "2026-11-06T10:35:00.000Z", model: "zeta/z1", provider: "Zeta", cost: 0.5 }),
      exchangeOf({ at: "2026-11-06T10:37:00.000Z", model: "alpha/a1", provider: "Alpha", cost: 0.5 }),
      "\n",
      "this line is not a record\n",
      exchangeOf({ kind: "client-request", at: "2026-11-06T10:40:00.000Z" }),
      exchangeOf({ at: "2026-11-06T10:50:00.000Z", status: 400, model: "x", provider: "y", cost: 9 }),
      exchangeOf({ at: "2026-11-06T11:00:00.000Z", noBody: true, cost: 0.1 }),
      record({ kind: "client-response", at: "2026-11-06T11:10:00.000Z", status: 200, body: body(undefined, "OnlyProvider"), usage: { raw: { cost: 0.2 }, tokens: {} } }),
      record({ kind: "client-response", at: "2026-11-06T11:20:00.000Z", status: 200, body: body("OnlyModel", undefined), usage: { raw: { cost: 0.3 }, tokens: {} } }),
      // No `at`: the record cannot be placed in time, so it is malformed, not an exchange.
      record({ kind: "client-response", status: 200, body: body("m", "p"), usage: { raw: { cost: 1 }, tokens: {} } }),
      // No cost: malformed too.
      record({ kind: "client-response", at: "2026-11-06T11:30:00.000Z", status: 200, body: body("m", "p"), usage: { tokens: {} } }),
      // An answer that ended after midnight belongs to the next day, although its file names this one.
      exchangeOf({ at: "2026-11-07T10:00:00.000Z", model: "later", provider: "DeepInfra", cost: 7 }),
    ]);
    // A usage day outside the window, and two names the log pattern never gives a day.
    usageLog(home, "2026-01-01", [exchangeOf({ at: "2026-01-01T10:00:00.000Z", model: "old", provider: "Old", cost: 9 })]);
    writeFileSync(join(logsDir(home), "2026-11-06-4242-proxy.1.log"), "a proxy log is not a usage log\n");
    writeFileSync(join(logsDir(home), "notes.txt"), "not a log\n");

    const json = await runProxy(home, ["cost", "--day", "2026-11-06", "--json"]);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as {
      coverage: string;
      malformed: number;
      summary: { totals: { cost: number; exchanges: number; perMillionOutput: number; cacheShare: number }; groups: { key: string; totals: { cost: number } }[] };
    };
    expect(report.coverage).toBe("complete");
    expect(report.malformed).toBe(3);
    expect(report.summary.totals.exchanges).toBe(7);
    expect(report.summary.totals.cost).toBeCloseTo(2.6, 10);
    expect(report.summary.groups.map((g) => g.key)).toEqual(["Alpha", "DeepInfra", "Google", "Zeta", "unknown", "OnlyProvider"]);

    const models = await runProxy(home, ["cost", "--day", "2026-11-06", "--by", "model"]);
    expect(models.code).toBe(0);
    expect(models.stdout).toContain("deepseek/deepseek-v4.1-flash-1017");

    const days = await runProxy(home, ["cost", "--since", "2026-11-06", "--until", "2026-11-07", "--by", "day", "--json"]);
    expect(days.code).toBe(0);
    expect((JSON.parse(days.stdout) as { summary: { groups: { key: string }[] } }).summary.groups.map((g) => g.key)).toEqual(["2026-11-06"]);

    // The earliest file is 2026-01-01, so a window from 2026-11-05 is complete; one from 2025 is not.
    const partial = await runProxy(home, ["cost", "--since", "2025-12-01", "--until", "2026-11-07"]);
    expect(partial.code).toBe(0);
    expect(partial.stdout).toContain("partial");
    expect(partial.stdout).toContain("read 2026-01-01");
  });

  test("uc-1: a logs directory with no log file in it reports nothing at all", async () => {
    home = await makeHome();
    mkdirSync(logsDir(home), { recursive: true });
    writeFileSync(join(logsDir(home), "notes.txt"), "not a log\n");
    const result = await runProxy(home, ["cost", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { coverage: string; summary: { groups: unknown[] } };
    expect(report.coverage).toBe("complete");
    expect(report.summary.groups).toEqual([]);
  });

  test("uc-1 negative: a record whose cache beats its prompt is refused, and the command exits 1", async () => {
    home = await makeHome();
    usageLog(home, "2026-11-06", [exchangeOf({ at: "2026-11-06T10:00:00.000Z", model: "m", provider: "p", cost: 0.1, tokens: { input: 10, output: 1, cacheRead: 11 } })]);
    const result = await runProxy(home, ["cost", "--day", "2026-11-06"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cached tokens 11 exceed prompt tokens 10");
  });

  test("uc-1 negative: each malformed option is a usage error and names what it wants", async () => {
    home = await makeHome();
    const cases: [string[], string][] = [
      [["cost", "--day"], "needs a value"],
      [["cost", "--day", "--json"], "needs a value"],
      [["cost", "--day", "2026-13-01"], "needs a date"],
      [["cost", "--since", "6/11/2026"], "needs a date"],
      [["cost", "--until", "yesterday"], "needs a date"],
      [["cost", "--by", "exchange"], "needs provider, model or day"],
      [["cost", "--watch", "soon"], "needs a number of seconds"],
      [["cost", "--watch", "1", "--budget-daily", "lots"], "needs a non-negative number"],
      [["cost", "--watch", "1", "--budget-monthly", "lots"], "needs a non-negative number"],
    ];
    for (const [argv, message] of cases) {
      const result = await runProxy(home, argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });
});

describe("cost --watch and --reconcile", () => {
  test("uc-5: the line repeats, and the daily ceiling that a later tick crosses ends it with exit 4", async () => {
    home = await makeHome();
    // Logs are named by UTC day (log-files.ts `dayOf`); today's window ends now, so both records sit just behind it.
    const today = new Date(Date.now() - 60_000).toISOString().slice(0, 10);
    usageLog(home, today, [exchangeOf({ at: new Date(Date.now() - 60_000).toISOString(), model: "m", provider: "DeepInfra", cost: 0.2 })]);
    // A file from the first of the month: the month's window is then complete, so only the daily ceiling can trip.
    const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    usageLog(home, new Date(monthStart).toISOString().slice(0, 10), [exchangeOf({ at: new Date(monthStart + 3_600_000).toISOString(), model: "m", provider: "DeepInfra", cost: 0.01 })]);
    const running = spawnProxyRunning(home, ["cost", "--watch", "1", "--budget-daily", "0.5"]);
    for (let i = 0; i < 400 && !running.output().includes("today"); i += 1) await Bun.sleep(25);
    expect(running.output()).toContain("today");
    // The next tick re-reads the files (one is new) and crosses the ceiling.
    usageLog(home, today, [exchangeOf({ at: new Date(Date.now() - 30_000).toISOString(), model: "m", provider: "DeepInfra", cost: 0.6 })]);
    const result = await running.done();
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("budget breached");
    expect(result.stdout).toContain("today");
  });

  test("uc-5: the monthly ceiling alone can be the one that trips, and a partial day says so", async () => {
    home = await makeHome();
    // Retention would leave the month short: the earliest file is after the month started, so the month is partial.
    const yesterday = Date.now() - 86_400_000;
    usageLog(home, new Date(yesterday).toISOString().slice(0, 10), [exchangeOf({ at: new Date(yesterday).toISOString(), model: "m", provider: "DeepInfra", cost: 0.2 })]);
    const result = await runProxy(home, ["cost", "--watch", "1", "--budget-monthly", "0.01"]);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("month (partial)");
    expect(result.stdout).toContain("this month");
  });

  test("uc-4: the estimate beside the actual charge, a lower estimate, an unreadable answer and a missing binary", async () => {
    home = await makeHome();
    usageLog(home, "2026-11-06", [exchangeOf({ at: "2026-11-06T10:00:00.000Z", model: "m", provider: "DeepInfra", cost: 1 })]);
    const fake = (script: string) => {
      const path = join(home!.bin, "opencode");
      writeFileSync(path, `#!/bin/sh\n${script}\n`);
      chmodSync(path, 0o755);
    };
    fake('echo \'{"cost":0.2}\'');
    const lower = await runProxy(home, ["cost", "--day", "2026-11-06", "--reconcile"]);
    expect(lower.code).toBe(0);
    expect(lower.stdout).toContain("estimate opencode $0.2000 · actual upstream $1.0000 · delta -80.0%");

    fake("exit 1");
    const unreadable = await runProxy(home, ["cost", "--day", "2026-11-06", "--reconcile"]);
    expect(unreadable.code).toBe(0);
    expect(unreadable.stdout).toContain("reconciliation skipped: unreadable");

    fake('echo "not json"');
    const garbage = await runProxy(home, ["cost", "--day", "2026-11-06", "--reconcile"]);
    expect(garbage.stdout).toContain("reconciliation skipped: unreadable");

    fake('echo \'{"cost":"1"}\'');
    const wrongType = await runProxy(home, ["cost", "--day", "2026-11-06", "--reconcile"]);
    expect(wrongType.stdout).toContain("reconciliation skipped: unreadable");

    fake('echo \'{"cost":1}\'');
    const since = await runProxy(home, ["cost", "--since", "2026-11-05", "--reconcile"]);
    expect(since.stdout).toContain("actual upstream $1.0000");

    // A day with nothing in it: the delta is reported as zero rather than as a division by zero.
    const nothing = await runProxy(home, ["cost", "--day", "2026-11-07", "--reconcile"]);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain("delta +0.0%");
  });

  test("uc-4: a client that hangs is killed at the 20 s cap, and the report says the estimate was unreadable", async () => {
    home = await makeHome();
    // A single process, so killing it also closes the pipe: a shell wrapper's `sleep` child would outlive it.
    const path = join(home.bin, "opencode");
    writeFileSync(path, `#!${process.execPath}\nawait Bun.sleep(120_000);\n`);
    chmodSync(path, 0o755);
    const started = Date.now();
    const result = await runProxy(home, ["cost", "--reconcile"]);
    const elapsed = Date.now() - started;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reconciliation skipped: unreadable");
    expect(elapsed).toBeGreaterThan(19_000);
    expect(elapsed).toBeLessThan(29_000);
  });

  test("uc-4 negative: no `opencode` on PATH is reported as skipped, never as a failure", async () => {
    home = await makeHome();
    const result = await runProxy(home, ["cost", "--reconcile"], { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reconciliation skipped: not-found");
  });
});
