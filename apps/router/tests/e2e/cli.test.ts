// The CLI black-box: each command is the real entry in its own process against the replay upstreams. Browser logins
// go through the fake `xdg-open`; the paste-code login reads the code from stdin.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { makeHome, runRouter, type Home } from "@inference-router/test-support/e2e/router-process.ts";
import { ReplayUpstreams } from "@inference-router/test-support/e2e/upstreams.ts";

const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
afterEach(() => {
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});
const run = (argv: string[], input?: Parameters<typeof runRouter>[3]) => runRouter(home!, argv, upstreams.seamEnv(), input);

describe("inference-router CLI (e2e)", () => {
  test("help, usage errors, and a refused seam", async () => {
    home = await makeHome();
    const help = await run(["help"]);
    expect([help.code, help.stdout.startsWith("usage: inference-router <command>")]).toEqual([0, true]);
    expect((await run(["frobnicate"])).code).toBe(2);
    const refused = await runRouter(home, ["help"], { ...upstreams.seamEnv(), INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API: "https://api.anthropic.com" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API must be an http://127.0.0.1:<port> origin");
  });

  test("an invalid router.yaml and a disabled provider are reported", async () => {
    home = await makeHome("providers:\n  claude: {enabled: true}\n");
    const invalid = await run(["models"]);
    expect([invalid.code, invalid.stderr.includes("enabled without acknowledgeTermsRisk: true")]).toEqual([1, true]);
    writeFileSync(join(home.dir, "router.yaml"), "port: 4999\n");
    const disabled = await run(["login", "claude"]);
    expect([disabled.code, disabled.stderr]).toEqual([1, "error: claude is disabled; enable it with acknowledgeTermsRisk: true in router.yaml\n"]);
  });

  test("browser logins for both providers, accounts, live models with their source, quota", async () => {
    home = await makeHome();
    const antigravity = await run(["login", "antigravity", "--timeout-seconds", "30"]);
    expect([antigravity.code, antigravity.stderr]).toEqual([0, ""]);
    expect(antigravity.stdout).toContain("signed in to antigravity as e2e@example.com (active account)");
    const claude = await run(["login", "claude", "--timeout-seconds", "30"]);
    expect([claude.code, claude.stderr]).toEqual([0, ""]);
    const opened = readFileSync(home.browserLog, "utf8").trim().split("\n").filter((l) => l.startsWith("http")).map((u) => new URL(u));
    expect(opened.map((u) => u.pathname)).toEqual(["/o/oauth2/v2/auth", "/cai/oauth/authorize"]);
    expect(opened[0]!.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);
    expect(opened[1]!.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(opened[1]!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(statSync(join(home.dir, "accounts-claude.json")).mode & 0o777).toBe(0o600);

    const accounts = await run(["account", "list", "antigravity"]);
    expect(accounts.stdout).toBe("* e2e@example.com\n");
    expect((await run(["account", "use", "antigravity", "e2e@example.com"])).stdout).toBe("active antigravity account: e2e@example.com\n");
    expect((await run(["account", "use", "antigravity", "nobody"])).code).toBe(1);

    const models = await run(["models"]);
    expect(models.code).toBe(0);
    expect(models.stdout).toContain("# claude: ");
    expect(models.stdout).toContain("(live catalog)");
    expect(models.stdout).toContain("claude/claude-opus-5  Claude Opus 5  context 1000000 / output 128000\n");
    expect(models.stdout).toContain("antigravity/gemini-3.6-flash-low  Gemini 3.6 Flash (Low)  context 80000 / output 65536\n");
    const cached = await run(["models", "claude"]);
    expect(cached.stdout.split("\n")[0]).toMatch(/^# claude: \d+ models \(stored copy of the live catalog\)$/);

    const quota = await run(["quota", "antigravity"]);
    expect([quota.code, quota.stdout.startsWith("Antigravity usage:")]).toEqual([0, true]);
    expect(await run(["quota", "claude"])).toMatchObject({ code: 1, stderr: "error: claude does not report usage\n" });
  });

  test("paste-code login (--manual) reads code#state from stdin", async () => {
    home = await makeHome();
    const result = await run(["login", "claude", "--manual"], async (stdout) => {
      for (let i = 0; i < 500 && !stdout().includes("code> "); i++) await Bun.sleep(10);
      const url = new URL(stdout().split("\n").find((l) => l.startsWith("http"))!);
      expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
      return `e2e-code#${url.searchParams.get("state")}\n`;
    });
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("signed in to claude as");
    expect((await run(["login", "antigravity", "--manual"])).stderr).toBe("error: antigravity has no paste-code login; use the browser login\n");
  });

  test("token is created once (0600) and reprinted; status reports a stopped daemon", async () => {
    home = await makeHome();
    const first = await run(["token"]);
    const second = await run(["token"]);
    expect(first.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(second.stdout).toBe(first.stdout);
    expect(statSync(join(home.dir, "token.json")).mode & 0o777).toBe(0o600);
    const status = await run(["status"]);
    expect(status.code).toBe(1);
    expect(status.stdout).toStartWith(`not running at http://127.0.0.1:${home.port} (nothing is listening: `);
  });
});
