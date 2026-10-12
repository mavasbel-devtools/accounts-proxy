// The CLI's failure paths, black-box: configuration errors, every way a browser login can fail, damaged stores,
// usage errors, a busy port and the status check against something that is not the router.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { BOTH_PROVIDERS, makeHome, runRouter, startDaemon, type Home } from "@inference-router/test-support/e2e/router-process.ts";
import { jsonResponse, ReplayUpstreams } from "@inference-router/test-support/e2e/upstreams.ts";

const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
afterEach(() => {
  upstreams.reset();
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});
const run = (argv: string[], env: Record<string, string> = {}) => runRouter(home!, argv, { ...upstreams.seamEnv(), ...env });
const writeYaml = (text: string) => writeFileSync(join(home!.dir, "router.yaml"), text);
const log = () => readFileSync(join(home!.dir, "logs", "router.log"), "utf8");

describe("configuration", () => {
  test.each([
    ["an unknown key", "foo: 1\n", "router.yaml: unknown key(s) foo in the document"],
    ["a non-boolean flag", "providers:\n  claude: {enabled: yes-please, acknowledgeTermsRisk: true}\n", "providers.claude.enabled must be true or false"],
    ["a sequence document", "- a\n", "the document must be a mapping"],
    ["a port that is not a number", "port: x\n", "port must be an integer 1-65535"],
    ["a port out of range", "port: 70000\n", "port must be an integer 1-65535"],
    ["providers as a list", "providers: []\n", "providers must be a mapping"],
    ["an unknown provider", "providers:\n  anthropic: {}\n", "unknown provider anthropic (known: claude, antigravity, openai, openrouter, opencode, opencode-go, cheaper-inference)"],
    ["a provider that is not a mapping", "providers:\n  claude: 1\n", "providers.claude must be a mapping"],
    ["aliases as a list", "aliases: []\n", "aliases must be a mapping"],
    ["an alias that is not a string", "aliases:\n  fast: 1\n", "aliases.fast must be a <provider>/<model> string"],
    ["a YAML syntax error", "port: [1, 2\n", "YAML syntax error"],
  ])("%s is reported (exit 1)", async (_name, yaml, message) => {
    home = await makeHome();
    writeYaml(yaml);
    const result = await run(["help"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test("an empty file is the default configuration; a BOM is tolerated; a directory in its place is an error", async () => {
    home = await makeHome();
    writeYaml("");
    expect((await run(["login", "claude"])).stderr).toBe("error: claude is disabled; enable it with acknowledgeTermsRisk: true in router.yaml\n");
    writeYaml(`\uFEFFport: 4999\naliases:\n  fast: claude/claude-haiku-4-5-20251001\n${BOTH_PROVIDERS}`);
    expect((await run(["help"])).code).toBe(0);
    writeFileSync(join(home.dir, "router.yaml.tmp"), "");
    removeTemporary(join(home.dir, "router.yaml.tmp"));
    const dir = join(home.dir, "router.yaml");
    removeTemporary(dir);
    mkdirSync(dir);
    const result = await run(["help"]);
    expect([result.code, result.stderr.includes("EISDIR")]).toEqual([1, true]);
  });
});

describe("browser login failures", () => {
  test.each([
    ["deny", "error: antigravity: authorization failed: access_denied (The user denied access); run `inference-router login antigravity`\n", "callback 400"],
    ["wrong-state", "error: antigravity: authorization state mismatch; run `inference-router login antigravity`\n", "callback 400"],
    ["no-code", "error: antigravity: authorization code missing from the callback; run `inference-router login antigravity`\n", "callback 400"],
  ])("the browser answers %s: the login fails and the browser page says so", async (mode, stderr, callback) => {
    home = await makeHome();
    const result = await run(["login", "antigravity", "--timeout-seconds", "30"], { INFERENCE_ROUTER_E2E_BROWSER_MODE: mode });
    expect([result.code, result.stderr]).toEqual([1, stderr]);
    expect(readFileSync(home.browserLog, "utf8")).toContain(callback);
  });

  test("no callback within the timeout; a browser that cannot be started is reported in the log", async () => {
    home = await makeHome();
    const ignored = await run(["login", "antigravity", "--timeout-seconds", "1"], { INFERENCE_ROUTER_E2E_BROWSER_MODE: "ignore" });
    expect([ignored.code, ignored.stderr]).toEqual([1, "error: no browser callback within 1 s\n"]);
    const missing = await run(["login", "claude", "--timeout-seconds", "1"], { PATH: join(home.dir, "no-such-dir") });
    expect(missing.code).toBe(1);
    expect(log()).toContain("WARN claude: could not open the browser");
  });

  test("other paths get 404 and a second callback 409; the first one signs in", async () => {
    home = await makeHome();
    const result = await run(["login", "claude", "--timeout-seconds", "30"], { INFERENCE_ROUTER_E2E_BROWSER_MODE: "wrong-path-twice" });
    expect([result.code, result.stderr]).toEqual([0, ""]);
    const lines = readFileSync(home.browserLog, "utf8").split("\n");
    expect(lines.filter((l) => l.startsWith("callback")).sort()).toEqual(["callback 302", "callback 404", "callback 409"]);
  });

  test("a failed code exchange fails the login and shows the reason on the browser page", async () => {
    home = await makeHome();
    upstreams.script("/token", () => jsonResponse({ error: "invalid_grant", error_description: "Bad Request" }, 400));
    const google = await run(["login", "antigravity", "--timeout-seconds", "30"]);
    expect(google.code).toBe(1);
    expect(google.stderr).toContain("antigravity");
    upstreams.script("/v1/oauth/token", () => jsonResponse({ token_type: "Bearer" }));
    const claude = await run(["login", "claude", "--timeout-seconds", "30"]);
    expect(claude.code).toBe(1);
    expect(readFileSync(home.browserLog, "utf8").split("\n").filter((l) => l.startsWith("callback"))).toEqual(["callback 400", "callback 400"]);
  });
});

describe("stores", () => {
  test("a damaged accounts file is an error, never silently replaced; a hand-edited label is shown", async () => {
    home = await makeHome();
    writeFileSync(join(home.dir, "accounts-claude.json"), "{not json");
    const broken = await run(["account", "list", "claude"]);
    expect([broken.code, broken.stderr.includes("accounts-claude.json is not valid")]).toEqual([1, true]);
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [{ provider: "antigravity", id: "x", label: "x", data: {} }] }));
    expect((await run(["account", "list", "claude"])).stderr).toContain("expected { accounts: AccountCredential[], activeId? }");
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [{ provider: "claude", id: "a@x", label: "Work", data: {} }] }));
    expect((await run(["account", "list", "claude"])).stdout).toBe("  a@x  (Work)\n");
    expect((await run(["account", "list", "antigravity"])).stdout).toBe("no antigravity accounts; run: inference-router login antigravity\n");
  });

  test("a damaged router token file is an error", async () => {
    home = await makeHome();
    writeFileSync(join(home.dir, "token.json"), '{"token":""}');
    const result = await run(["token"]);
    expect([result.code, result.stderr.includes("token.json is not valid")]).toEqual([1, true]);
  });
});

describe("usage errors (exit 2)", () => {
  test.each([
    [["login"], "missing or extra arguments"],
    [["login", "anthropic"], "unknown provider anthropic"],
    [["login", "claude", "--bogus"], "unknown login option --bogus"],
    [["login", "claude", "--timeout-seconds", "0"], "--timeout-seconds needs a positive integer"],
    [["account", "use", "claude"], "account list <provider> | account use <provider> <account-id>"],
    [["quota"], "missing or extra arguments"],
    [["models", "claude", "antigravity"], "models takes at most one provider"],
    [["serve", "now"], "serve takes no arguments"],
    [["token", "again"], "token takes no arguments"],
    [["status", "please"], "status takes no arguments"],
  ])("%p", async (argv, message) => {
    home ??= await makeHome();
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith(message);
  });
});

describe("serve and status", () => {
  test("a busy port is fatal; status against something else answers not running", async () => {
    home = await makeHome("providers: {}\n", Number(new URL(upstreams.origin).port));
    const busy = await run(["serve"]);
    expect([busy.code, busy.stderr]).toEqual([1, `error: 127.0.0.1:${new URL(upstreams.origin).port} is already in use (another inference-router, or another program); choose another port in router.yaml\n`]);
    const notFound = await run(["status"]);
    expect([notFound.code, notFound.stdout]).toEqual([1, `not running at ${upstreams.origin} (GET /health answered HTTP 404)\n`]);
    upstreams.script("/health", () => jsonResponse({ status: "down" }));
    expect((await run(["status"])).stdout).toBe(`not running at ${upstreams.origin} (GET /health is not an inference-router health answer)\n`);
  });

  test("a daemon with no provider enabled serves health and says so", async () => {
    home = await makeHome("providers: {}\n");
    const daemon = await startDaemon(home, upstreams.seamEnv());
    expect(daemon.output()).toContain("(providers: none)");
    expect((await run(["status"])).stdout).toBe(`running at ${daemon.url} (providers: none)\n`);
    expect((await daemon.stop()).code).toBe(0);
  });
});
