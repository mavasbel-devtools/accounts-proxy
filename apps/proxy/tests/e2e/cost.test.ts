// `cost`, black-box (plan 2026-11-06-15-21, stages 5 and 6): a real process, a real home, a usage log the reader finds.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { logsDir, makeHome, runProxy, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";

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
