// The CLI black-box: each command is the real entry in its own process against the replay upstreams. Browser logins
// go through the fake `xdg-open`; the paste-code login reads the code from stdin.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, type Home, accountsFile, readPool } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
afterEach(() => {
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});
const run = (argv: string[], input?: Parameters<typeof runProxy>[3]) => runProxy(home!, argv, upstreams.seamEnv(), input);

/**
 * Waits until the proxy process of `homeDir` (found by its ACCOUNTS_PROXY_HOME in /proc/<pid>/environ) is idle in its
 * lock-wait loop: its CPU time (utime + stime, /proc/<pid>/stat fields 14-15) grows by at most one tick over 1 s. Its
 * start, instrumented for coverage, keeps the CPU busy; a process polling a busy lock does not.
 */
async function idleWaiting(homeDir: string): Promise<void> {
  const marker = `ACCOUNTS_PROXY_HOME=${homeDir}\0`;
  const cpu = (pid: string) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ").slice(11, 13).reduce((sum, ticks) => sum + Number(ticks), 0);
  for (let i = 0; i < 600; i++) {
    const pid = readdirSync("/proc").find((entry) => /^\d+$/.test(entry) && (() => {
      try {
        return readFileSync(`/proc/${entry}/environ`, "latin1").includes(marker);
      } catch {
        return false;
      }
    })());
    if (pid !== undefined) {
      const before = cpu(pid);
      await Bun.sleep(1_000);
      if (cpu(pid) - before <= 1) return;
    } else await Bun.sleep(100);
  }
  throw new Error("the proxy process never waited for the lock");
}

describe("accounts-proxy CLI (e2e)", () => {
  test("help, usage errors, and a refused seam", async () => {
    home = await makeHome();
    const help = await run(["help"]);
    expect([help.code, help.stdout.startsWith("bun run proxy — one local endpoint")]).toEqual([0, true]);
    for (const argv of [[], ["--help"], ["-h"]]) expect(await run(argv)).toMatchObject({ code: 0, stdout: help.stdout, stderr: "" });
    const wrong = await run(["frobnicate"]);
    expect([wrong.code, wrong.stdout, wrong.stderr.split("\n")[0]]).toEqual([2, "", "unknown command frobnicate"]);
    expect(wrong.stderr).toContain("\nfor options, exit codes and examples: bun run proxy help\n");
    const refused = await runProxy(home, ["help"], { ...upstreams.seamEnv(), ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API: "https://api.anthropic.com" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API must be an http://127.0.0.1:<port> origin");
  });

  test.each(["login", "account", "account list", "account use", "quota", "models", "opencode-config", "pi-config", "serve", "token", "status", "help"])(
    "`help %s`, `--help` and `-h` print the same help, without running the command",
    async (command: string) => {
      const words = command.split(" ");
      home = await makeHome();
      const [help, long, short] = await Promise.all([run(["help", ...words]), run([...words, "--help"]), run([...words, "-h"])]);
      expect([help.code, help.stderr, help.stdout.split("\n")[0]!.startsWith(`bun run proxy ${words.join(" ")} — `)]).toEqual([0, "", true]);
      for (const section of ["\nusage:\n", "\noptions:\n  ", "\nexit codes:\n", "\nexamples:\n"]) expect(help.stdout).toContain(section);
      for (const other of [long, short]) expect(other).toMatchObject({ code: 0, stdout: help.stdout, stderr: "" });
    },
  );

  test("help flags after arguments, misspelt commands and a missing argument", async () => {
    home = await makeHome();
    // A help flag after the arguments still prints the help, so `serve` never starts and `login` never opens a browser.
    expect(await run(["serve", "--help"])).toMatchObject({ code: 0, stdout: (await run(["help", "serve"])).stdout });
    expect((await run(["login", "claude", "--manual", "-h"])).stdout).toBe((await run(["help", "login"])).stdout);
    const nested = await run(["account", "lst", "--help"]);
    expect([nested.code, nested.stdout, nested.stderr.split("\n")[0]]).toEqual([2, "", "unknown account subcommand lst (did you mean list?)"]);
    const unknown = await run(["help", "logn"]);
    expect([unknown.code, unknown.stderr.split("\n")[0]]).toEqual([2, "unknown command logn (did you mean login?)"]);
    const subcommand = await run(["help", "account", "lst"]);
    expect([subcommand.code, subcommand.stderr.split("\n")[0]]).toEqual([2, "unknown account subcommand lst (did you mean list?)"]);
    const leaf = await run(["help", "login", "claude"]);
    expect([leaf.code, leaf.stderr.split("\n")[0]]).toEqual([2, "login has no subcommands"]);
    const group = await run(["account"]);
    expect([group.code, group.stderr]).toEqual([2, "missing account subcommand: one of list, use, remove\nusage: bun run proxy account list <provider>\n       bun run proxy account use <provider> <account-id>\n       bun run proxy account remove <provider> <account-id>\nfor options, exit codes and examples: bun run proxy help account\n"]);
    // After `--` a help flag is an argument like any other: `serve` takes none.
    const separated = await run(["serve", "--", "--help"]);
    expect([separated.code, separated.stderr.split("\n")[0]]).toEqual([2, "serve takes no arguments"]);
    const missing = await run(["login"]);
    expect([missing.code, missing.stderr]).toEqual([2, "login needs a provider\nusage: bun run proxy login <provider> [--manual] [--new] [--key] [--timeout-seconds N]\nfor options, exit codes and examples: bun run proxy help login\n"]);
  });

  test("an invalid proxy.yaml and a disabled provider are reported", async () => {
    home = await makeHome("providers:\n  claude: {enabled: true}\n");
    const invalid = await run(["models"]);
    expect([invalid.code, invalid.stderr.includes("enabled without acknowledgeTermsRisk: true")]).toEqual([1, true]);
    writeFileSync(join(home.dir, "proxy.yaml"), "port: 4999\n");
    const disabled = await run(["login", "claude"]);
    expect([disabled.code, disabled.stderr]).toEqual([1, "error: claude is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n"]);
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
    expect(statSync(accountsFile(home)).mode & 0o777).toBe(0o600);

    const accounts = await run(["account", "list", "antigravity"]);
    expect(accounts.stdout).toBe("* e2e@example.com\n");
    expect((await run(["account", "use", "antigravity", "e2e@example.com"])).stdout).toBe("active antigravity account: e2e@example.com\n");
    expect((await run(["account", "use", "antigravity", "nobody"])).code).toBe(1);

    const models = await run(["models"]);
    expect(models.code).toBe(0);
    expect(models.stdout).toContain("# claude: ");
    expect(models.stdout).toContain("(live catalog)");
    expect(models.stdout).toContain("claude/claude-opus-5  Claude Opus 5  context 1000000 / output 128000\n");
    expect(models.stdout).toContain("antigravity/gemini-3.6-flash-low  Gemini 3.6 Flash (Low)  context 1048576 / output 65536\n");
    const cached = await run(["models", "claude"]);
    expect(cached.stdout.split("\n")[0]).toMatch(/^# claude: \d+ models \(stored copy of the live catalog\)$/);

    const quota = await run(["quota", "antigravity"]);
    expect([quota.code, quota.stdout.startsWith("Antigravity usage:")]).toEqual([0, true]);
    expect(await run(["quota", "claude"])).toMatchObject({ code: 1, stderr: "error: claude does not report usage\n" });

    // account remove (plan 2026-10-26 A1): unknown id fails; removing the only, active account leaves none active.
    expect(await run(["account", "remove", "antigravity", "nobody"])).toMatchObject({ code: 1, stderr: "error: no antigravity account \"nobody\"\n" });
    expect(await run(["account", "remove", "antigravity", "e2e@example.com"])).toMatchObject({ code: 0, stdout: "removed antigravity account: e2e@example.com\nno antigravity accounts left; run: bun run proxy login antigravity\n" });
    expect(readPool(home, "antigravity")).toBeUndefined();
  });

  test("paste-code login (--manual) reads code#state from stdin", async () => {
    home = await makeHome();
    const result = await run(["login", "claude", "--manual"], async (stdout) => {
      for (let i = 0; i < 3000 && !stdout().includes("code> "); i++) await Bun.sleep(10);
      const url = new URL(stdout().split("\n").find((l) => l.startsWith("http"))!);
      expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
      return `e2e-code#${url.searchParams.get("state")}\n`;
    });
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("signed in to claude as");
    expect((await run(["login", "antigravity", "--manual"])).stderr).toBe("error: antigravity has no paste-code login; use the browser login\n");
  });

  test("the token is created under the token lock: a token another process stored while this one waited is kept (W1)", async () => {
    home = await makeHome();
    mkdirSync(join(home.dir, "locks"), { recursive: true, mode: 0o700 });
    const lock = join(home.dir, "locks", "token.lock");
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    const waiting = run(["token"]);
    // The process reads no token, then waits for the lock; meanwhile "another process" stores one and releases it.
    await idleWaiting(home.dir);
    const other = "o".repeat(43);
    writeFileSync(join(home.dir, "token.json"), JSON.stringify({ token: other }));
    rmSync(lock);
    const result = await waiting;
    expect([result.code, result.stdout]).toEqual([0, `${other}\n`]);
    expect(JSON.parse(readFileSync(join(home.dir, "token.json"), "utf8"))).toEqual({ token: other });
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
