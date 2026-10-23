// The composition root and the process entry, in process: real file stores, real loopback listener, real lock;
// only the network (ScriptedTransport) and the browser are replaced. The fake browser behaves like a user who
// approves: it calls the loopback redirect with the code and the state from the authorization URL.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { UPSTREAM_IDLE_TIMEOUT_MS, type HttpRequest } from "@accounts-proxy/core/domain/wire.ts";
import { BrowserLauncherPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { ScriptedTransport, type ScriptedResponse } from "@accounts-proxy/test-support/fakes.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";
import { FetchTransport, type FetchFunction } from "@accounts-proxy/proxy/adapters/outbound/fetch-transport.ts";
import { buildCli, defaultHome, hooksFrom, PRODUCTION_LOCK, runCli, seamsFrom, TestHookError, type ContainerOptions } from "@accounts-proxy/proxy/composition/container.ts";

let home: string | undefined;
afterEach(() => {
  if (home !== undefined) removeTemporary(home);
  home = undefined;
});

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "provider-antigravity", "tests", "fixtures", "plugin-5c6f7c2", name), "utf8");
const json = (body: unknown): ScriptedResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function google(request: HttpRequest): ScriptedResponse {
  if (request.url === "https://oauth2.googleapis.com/token") return json({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
  const op = request.url.split("v1internal:")[1];
  if (op === "fetchUserInfo") return json({ userSettings: { email: "me@x" } });
  if (op === "loadCodeAssist") return json({ cloudaicompanionProject: "proj-1" });
  if (op === "fetchAvailableModels") return { status: 200, body: fixture("fetch-available-models.sample.json") };
  if (op === "retrieveUserQuotaSummary") return { status: 200, body: fixture("retrieve-user-quota-summary.sample.json") };
  return { status: 404, body: request.url };
}

class ApprovingBrowser extends BrowserLauncherPort {
  opened: string[] = [];
  async open(url: string): Promise<void> {
    this.opened.push(url);
    const params = new URL(url).searchParams;
    void fetch(`${params.get("redirect_uri")}?code=c0de&state=${params.get("state")}`, { redirect: "manual" });
  }
}

class ManualSignal extends ShutdownSignal {
  private fire!: (name: string) => void;
  private readonly fired = new Promise<string>((resolve) => (this.fire = resolve));
  wait() {
    return this.fired;
  }
  trigger(name: string) {
    this.fire(name);
  }
}

function options(extra: Partial<ContainerOptions> = {}) {
  home = makeTemporary("proxy-container");
  const out: string[] = [];
  const err: string[] = [];
  const transport = new ScriptedTransport(google);
  const browser = new ApprovingBrowser();
  const opts: ContainerOptions = {
    home,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    transport,
    browser,
    shutdown: new ManualSignal(),
    lock: PRODUCTION_LOCK,
    seams: {},
    listenHost: "127.0.0.1",
    opencodeData: join(home, "opencode-data"),
    entry: ["/usr/bin/bun", "/app/cli.ts"],
    ...extra,
  };
  return { opts, out, err, transport, browser };
}

const BOTH = "providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n";

describe("composition root", () => {
  test("no proxy.yaml: every provider disabled, default port", async () => {
    const { opts, err } = options();
    const { config } = await buildCli(opts);
    expect(config.port).toBe(4141);
    expect(await runCli(["login", "antigravity"], opts)).toBe(1);
    expect(err).toEqual(["error: antigravity is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n"]);
  });

  test("antigravity end to end in process: browser login over the real loopback, account, models, quota", async () => {
    const { opts, out, err, transport, browser } = options();
    writeFileSync(join(home!, "proxy.yaml"), BOTH);
    expect(await runCli(["login", "antigravity", "--timeout-seconds", "10"], opts)).toBe(0);
    expect(err).toEqual([]);
    expect(browser.opened).toHaveLength(1);
    expect(new URL(browser.opened[0]!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);
    expect(out.at(-1)).toBe("signed in to antigravity as me@x (active account)\n");
    const stored = JSON.parse(readFileSync(join(home!, "accounts-antigravity.json"), "utf8")) as { activeId: string };
    expect(stored.activeId).toBe("me@x");
    expect(await runCli(["account", "list", "antigravity"], opts)).toBe(0);
    expect(await runCli(["models", "antigravity"], opts)).toBe(0);
    expect(await runCli(["quota", "antigravity"], opts)).toBe(0);
    expect(out.slice(-1)[0]!.startsWith("Antigravity usage:")).toBe(true);
    expect(out).toContain("* me@x\n");
    expect(out).toContain("antigravity/gemini-3.6-flash-low  Gemini 3.6 Flash (Low)  context 80000 / output 65536\n");
    expect(transport.requests.some((r) => r.url.endsWith("v1internal:fetchAvailableModels"))).toBe(true);
    expect(readFileSync(join(home!, "logs", "proxy.log"), "utf8")).toContain("INFO antigravity: signed in account me@x");
  });

  test("openai is wired when enabled, on the production hosts or on the seams; without an account its list is the built-in one", async () => {
    for (const seams of [{}, { openaiApi: "http://127.0.0.1:1", openaiAuth: "http://127.0.0.1:1" }]) {
      const { opts, out, transport } = options({ seams });
      writeFileSync(join(home!, "proxy.yaml"), "providers:\n  openai: {enabled: true, acknowledgeTermsRisk: true}\n");
      expect(await runCli(["models", "openai"], opts)).toBe(0);
      expect(out[0]).toBe("# openai: 16 models (built-in list: the live catalog was unavailable)\n");
      expect(await runCli(["account", "list", "openai"], opts)).toBe(0);
      expect(out.at(-1)).toBe("no openai accounts; run: accounts-proxy login openai\n");
      // The detailed list reads the reference catalog (rule M4; the gateways seam, unset here, would repoint it).
      expect(transport.requests.map((r) => r.url)).toEqual(["https://models.opencode.ai/api.json"]);
      removeTemporary(home!);
      home = undefined;
    }
  });

  test("the API-key gateways (plan P4.6) are wired when enabled, on the production hosts or on the gateways seam", async () => {
    const GATEWAYS = "providers:\n  openrouter: {enabled: true}\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n  cheaper-inference: {enabled: true}\n";
    for (const [seams, origin] of [
      [{}, undefined],
      [{ gateways: "http://127.0.0.1:1" }, "http://127.0.0.1:1"],
    ] as const) {
      const { opts, out, transport } = options({ seams });
      writeFileSync(join(home!, "proxy.yaml"), GATEWAYS);
      expect(await runCli(["models"], opts)).toBe(0);
      expect(out.filter((l) => l.startsWith("# "))).toEqual([
        "# openrouter: 459 models (built-in list: the live catalog was unavailable)\n",
        "# opencode: 124 models (built-in list: the live catalog was unavailable)\n",
        "# opencode-go: 31 models (built-in list: the live catalog was unavailable)\n",
        "# cheaper-inference: 91 models (built-in list: the live catalog was unavailable)\n",
      ]);
      const at = (url: string) => (origin === undefined ? url : `${origin}${new URL(url).pathname}`);
      expect(transport.requests.map((r) => r.url)).toEqual([
        at("https://openrouter.ai/api/v1/models"),
        // O5: OpenCode's lists are the reference catalog's (its unreachable answer is not kept, so each list asks).
        at("https://models.opencode.ai/api.json"),
        at("https://models.opencode.ai/api.json"),
        at("https://api.cheaperinference.com/public/models"),
        at("https://models.opencode.ai/api.json"),
      ]);
      removeTemporary(home!);
      home = undefined;
    }
  });

  test("an API-key login reads the key from the hidden prompt; quota and the keyed model list use it", async () => {
    const stdin = new PassThrough();
    const transport = new ScriptedTransport((request) => {
      if (request.url.endsWith("/v1/account")) return json({ email: "me@x", workspace_name: "Team" });
      if (request.url.endsWith("/v1/account/balance")) return json({ currency: "USD", balance_usd: 2, available_usd: 2, reserved_usd: 0 });
      if (request.url.endsWith("/v1/models")) return json({ data: [{ id: "m", supported_endpoints: ["/v1/chat/completions"] }] });
      return { status: 404 };
    });
    const { opts, out } = options({ stdin, transport });
    writeFileSync(join(home!, "proxy.yaml"), "providers:\n  cheaper-inference: {enabled: true}\n");
    stdin.write("ci_live_1\n");
    expect(await runCli(["login", "cheaper-inference"], opts)).toBe(0);
    expect(out.at(-1)).toBe("signed in to cheaper-inference as Team (active account)\n");
    expect(await runCli(["quota", "cheaper-inference"], opts)).toBe(0);
    expect(out.at(-1)).toBe('Cheaper Inference wallet (GET /v1/account/balance):\n  currency: "USD"\n  balance_usd: 2\n  available_usd: 2\n  reserved_usd: 0\n');
    expect(await runCli(["models", "cheaper-inference"], opts)).toBe(0);
    expect(out.slice(-2)).toEqual(["# cheaper-inference: 1 models (live catalog)\n", "cheaper-inference/m  m\n"]);
    expect(transport.requests.map((r) => [r.url, r.headers["authorization"]])).toEqual([
      ["https://api.cheaperinference.com/v1/account", "Bearer ci_live_1"],
      ["https://api.cheaperinference.com/v1/account/balance", "Bearer ci_live_1"],
      ["https://api.cheaperinference.com/v1/models", "Bearer ci_live_1"],
    ]);
    expect(JSON.parse(readFileSync(join(home!, "accounts-cheaper-inference.json"), "utf8"))).toEqual({ accounts: [{ provider: "cheaper-inference", id: "me@x", label: "Team", data: { apiKey: "ci_live_1" } }], activeId: "me@x" });
  });

  test("OpenCode (amendment A): one Console account for opencode and opencode-go; --from-opencode imports OpenCode's key, checked against the workspace config", async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.url.endsWith("/console/api/v2/config")) return json({ providers: { opencode: { headers: { "x-opencode-org-id": "org_1" } }, "opencode-go": { headers: { "x-opencode-org-id": "org_1" } } } });
      return { status: 404 };
    });
    const { opts, out } = options({ transport });
    writeFileSync(join(home!, "proxy.yaml"), "providers:\n  opencode-go: {enabled: true}\n");
    mkdirSync(join(home!, "opencode-data"));
    writeFileSync(join(home!, "opencode-data", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "oc_sk_go" } }));
    expect(await runCli(["login", "opencode-go", "--from-opencode"], opts)).toBe(0);
    expect(out.at(-1)).toBe("signed in to opencode-go as key-5645e3d2 (active account)\n");
    expect(JSON.parse(readFileSync(join(home!, "accounts-opencode.json"), "utf8"))).toEqual({
      accounts: [{ provider: "opencode", id: "key-5645e3d2", label: "key-5645e3d2", data: { workspaceHeaders: { opencode: { "x-opencode-org-id": "org_1" }, "opencode-go": { "x-opencode-org-id": "org_1" } }, apiKey: "oc_sk_go" } }],
      activeId: "key-5645e3d2",
    });
    expect(await runCli(["account", "list", "opencode-go"], opts)).toBe(0);
    expect(out.at(-1)).toBe("* key-5645e3d2\n");
    expect(await runCli(["login", "opencode"], opts)).toBe(1);
    expect(transport.requests.map((r) => [r.url, r.headers["authorization"]])).toEqual([["https://opencode.ai/console/api/v2/config", "Bearer oc_sk_go"]]);
  });

  test("an invalid proxy.yaml is reported, not thrown", async () => {
    const { opts, err } = options();
    writeFileSync(join(home!, "proxy.yaml"), "providers:\n  antigravity: {enabled: true}\n");
    expect(await runCli(["help"], opts)).toBe(1);
    expect(err[0]).toContain("enabled without acknowledgeTermsRisk: true");
    writeFileSync(join(home!, "proxy.yaml"), "port: [1, 2\n");
    expect(await runCli(["help"], opts)).toBe(1);
    expect(err[1]).toContain("YAML syntax error");
  });

  test("a failure while building is rendered", async () => {
    const { opts, err } = options();
    const hostile = { ...opts };
    Object.defineProperty(hostile, "home", { get: () => { throw new Error("no home"); } });
    expect(await runCli(["help"], hostile)).toBe(1);
    expect(err).toEqual(["error: no home\n"]);
  });

  test("default home: ACCOUNTS_PROXY_HOME, else ~/.local/share/accounts-proxy", async () => {
    const { homedir } = await import("node:os");
    expect(defaultHome({ ACCOUNTS_PROXY_HOME: "X:/h" })).toBe("X:/h");
    expect(defaultHome({})).toBe(join(homedir(), ".local", "share", "accounts-proxy"));
  });
});

describe("process entry (main/cli.ts)", () => {
  test("maps argv and the environment onto the CLI and sets the exit code", async () => {
    home = makeTemporary("proxy-entry");
    const saved = { argv: process.argv, env: process.env["ACCOUNTS_PROXY_HOME"], write: process.stdout.write, ewrite: process.stderr.write, exitCode: process.exitCode };
    const printed: string[] = [];
    const errors: string[] = [];
    process.argv = [process.argv[0]!, "cli.ts", "help"];
    process.env["ACCOUNTS_PROXY_HOME"] = home;
    process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await import("@accounts-proxy/proxy/main/cli.ts");
      expect(process.exitCode).toBe(0);
      const { main } = await import("@accounts-proxy/proxy/composition/container.ts");
      expect(await main(["frobnicate"])).toBe(2);
      expect(errors.join("")).toContain("unknown command frobnicate");
    } finally {
      process.argv = saved.argv;
      process.stdout.write = saved.write;
      process.stderr.write = saved.ewrite;
      process.exitCode = saved.exitCode;
      if (saved.env === undefined) delete process.env["ACCOUNTS_PROXY_HOME"];
      else process.env["ACCOUNTS_PROXY_HOME"] = saved.env;
    }
    expect(printed.join("")).toContain("usage: accounts-proxy <command>");
  });
});


async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Replays the Google OAuth + cloudcode-pa endpoints the seams point at (paths of the production URLs). */
function replayGoogle() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      const reply = (body: unknown) => Response.json(body);
      if (path === "/token") return reply({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
      const op = path.split("v1internal:")[1];
      if (op === "fetchUserInfo") return reply({ userSettings: { email: "me@x" } });
      if (op === "loadCodeAssist") return reply({ cloudaicompanionProject: "proj-1" });
      if (op === "fetchAvailableModels") return new Response(fixture("fetch-available-models.sample.json"));
      if (op === "streamGenerateContent") return new Response(fixture("stream-generate.sample.sse"), { headers: { "content-type": "text/event-stream" } });
      return new Response(path, { status: 404 });
    },
  });
}

describe("daemon wiring (serve, token, status) over the upstream seams", () => {
  test("login, serve, authenticated native Gemini stream, model lists with their source, status, SIGTERM drain", async () => {
    const upstream = replayGoogle();
    try {
      const origin = `http://127.0.0.1:${upstream.port}`;
      const seams = { antigravityApi: origin, googleOAuth: origin, claudeApi: origin, claudeOAuth: origin };
      const shutdown = new ManualSignal();
      const { opts: real, out, err } = options({ seams, shutdown, transport: new FetchTransport(fetch as unknown as FetchFunction, UPSTREAM_IDLE_TIMEOUT_MS) });
      const port = await freePort();
      writeFileSync(join(home!, "proxy.yaml"), `port: ${port}\n${BOTH}`);
      expect(await runCli(["login", "antigravity", "--timeout-seconds", "10"], real)).toBe(0);
      expect(await runCli(["status"], real)).toBe(1);
      expect(out.at(-1)).toMatch(new RegExp(`^not running at http://127\\.0\\.0\\.1:${port} \\(`));

      const serving = runCli(["serve"], real);
      for (let i = 0; i < 200 && !out.some((l) => l.startsWith("accounts-proxy listening")); i++) await Bun.sleep(10);
      expect(out).toContain(`accounts-proxy listening on http://127.0.0.1:${port} (providers: claude, antigravity)\n`);
      expect(await runCli(["token"], real)).toBe(0);
      const token = out.at(-1)!.trim();
      expect(JSON.parse(readFileSync(join(home!, "token.json"), "utf8"))).toEqual({ token });

      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok", providers: ["claude", "antigravity"] });
      expect((await fetch(`${base}/gemini/v1beta/models`)).status).toBe(401);
      const stream = await fetch(`${base}/gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect((await stream.text()).split("\r\n\r\n").filter((f) => f.startsWith("data: "))).toHaveLength(3);
      const listed = await fetch(`${base}/anthropic/v1/models`, { headers: { "x-api-key": token } });
      expect(listed.headers.get("x-proxy-models-source")).toBe("claude=static,antigravity=live");

      expect(await runCli(["status"], real)).toBe(0);
      expect(out.at(-1)).toBe(`running at ${base} (providers: claude, antigravity)\n`);
      shutdown.trigger("SIGTERM");
      expect(await serving).toBe(0);
      expect(out.slice(-2)).toEqual(["SIGTERM: stopping (in-flight responses get 10 s)\n", "stopped\n"]);
      expect(err).toEqual([]);
    } finally {
      upstream.stop(true);
    }
  });

  test("seams accept only http://127.0.0.1:<port> origins", () => {
    expect(seamsFrom({})).toEqual({});
    expect(seamsFrom({ ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API: "http://127.0.0.1:5001", ACCOUNTS_PROXY_TEST_UPSTREAM_GOOGLE_OAUTH: "http://127.0.0.1:5002/" })).toEqual({
      claudeApi: "http://127.0.0.1:5001",
      googleOAuth: "http://127.0.0.1:5002",
    });
    for (const value of ["https://127.0.0.1:1", "http://localhost:1", "http://127.0.0.1:1/v1", "http://127.0.0.1:1/?x=1", "not a url", "http://api.anthropic.com"]) {
      expect(() => seamsFrom({ ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API: value })).toThrow("ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API must be an http://127.0.0.1:<port> origin");
    }
  });

  test("main refuses a seam that is not loopback before building anything", async () => {
    const saved = { ewrite: process.stderr.write, env: process.env["ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH"] };
    const errors: string[] = [];
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    process.env["ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH"] = "https://claude.com";
    try {
      const { main } = await import("@accounts-proxy/proxy/composition/container.ts");
      expect(await main(["help"])).toBe(1);
      expect(errors.join("")).toBe('error: ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH must be an http://127.0.0.1:<port> origin (hermetic tests only), got "https://claude.com"\n');
    } finally {
      process.stderr.write = saved.ewrite;
      if (saved.env === undefined) delete process.env["ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH"];
      else process.env["ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH"] = saved.env;
    }
  });
});

describe("hermetic test hooks", () => {
  const seams = { claudeApi: "http://127.0.0.1:1", claudeOAuth: "http://127.0.0.1:1", antigravityApi: "http://127.0.0.1:1", googleOAuth: "http://127.0.0.1:1", openaiApi: "http://127.0.0.1:1", openaiAuth: "http://127.0.0.1:1", gateways: "http://127.0.0.1:1" };

  test("absent: nothing changes; present: parsed", () => {
    expect(hooksFrom({}, {})).toEqual({ platform: undefined, upstreamIdleMs: undefined, lockTimeoutMs: undefined, lockStatVanishes: false, listenUnassigned: false });
    const env = { ACCOUNTS_PROXY_TEST_PLATFORM: "win32", ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS: "1000", ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS: "200", ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES: "1", ACCOUNTS_PROXY_TEST_LISTEN_UNASSIGNED: "1" };
    expect(hooksFrom(env, seams)).toEqual({ platform: "win32", upstreamIdleMs: 1000, lockTimeoutMs: 200, lockStatVanishes: true, listenUnassigned: true });
  });

  test.each([
    [{ ACCOUNTS_PROXY_TEST_PLATFORM: "linux" }, { claudeApi: "http://127.0.0.1:1" }, "ACCOUNTS_PROXY_TEST_PLATFORM need every ACCOUNTS_PROXY_TEST_UPSTREAM_* seam (hermetic tests only)"],
    [{ ACCOUNTS_PROXY_TEST_PLATFORM: "aix" }, seams, "ACCOUNTS_PROXY_TEST_PLATFORM must be one of linux, darwin, win32"],
    [{ ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS: "1.5" }, seams, "ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS must be a positive integer (milliseconds)"],
    [{ ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS: "0" }, seams, "ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS must be a positive integer (milliseconds)"],
    [{ ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES: "yes" }, seams, "ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES must be 1"],
  ])("%p is refused", (env, given, message) => {
    expect(() => hooksFrom(env, given)).toThrow(new TestHookError(message));
  });

  test("main wires the vanishing-stat and unassigned-listen hooks", async () => {
    home = makeTemporary("proxy-hooks");
    const keys = { ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_GOOGLE_OAUTH: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_API: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_AUTH: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_UPSTREAM_GATEWAYS: "http://127.0.0.1:1", ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES: "1", ACCOUNTS_PROXY_TEST_LISTEN_UNASSIGNED: "1", ACCOUNTS_PROXY_HOME: home };
    const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
    const write = process.stdout.write;
    Object.assign(process.env, keys);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const { main } = await import("@accounts-proxy/proxy/composition/container.ts");
      expect(await main(["help"])).toBe(0);
    } finally {
      process.stdout.write = write;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
