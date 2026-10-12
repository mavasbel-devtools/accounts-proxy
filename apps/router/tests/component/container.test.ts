// The composition root and the process entry, in process: real file stores, real loopback listener, real lock;
// only the network (ScriptedTransport) and the browser are replaced. The fake browser behaves like a user who
// approves: it calls the loopback redirect with the code and the state from the authorization URL.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { HttpRequest } from "@inference-router/core/domain/wire.ts";
import { BrowserLauncherPort } from "@inference-router/core/ports/outbound/system.ts";
import { ScriptedTransport, type ScriptedResponse } from "@inference-router/test-support/fakes.ts";
import { makeTemporary, removeTemporary } from "@inference-router/test-support/temporary.ts";
import { ShutdownSignal } from "@inference-router/router/adapters/inbound/server.ts";
import { buildCli, defaultHome, runCli, seamsFrom, type ContainerOptions } from "@inference-router/router/composition/container.ts";

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

function options(extra: Partial<ContainerOptions> = {}) {
  home = makeTemporary("router-container");
  const out: string[] = [];
  const err: string[] = [];
  const transport = new ScriptedTransport(google);
  const browser = new ApprovingBrowser();
  const opts: ContainerOptions = { home, out: (t) => out.push(t), err: (t) => err.push(t), stdin: new PassThrough(), stdout: new PassThrough(), transport, browser, ...extra };
  return { opts, out, err, transport, browser };
}

const BOTH = "providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n";

describe("composition root", () => {
  test("no router.yaml: every provider disabled, default port", async () => {
    const { opts, err } = options();
    const { config } = await buildCli(opts);
    expect(config.port).toBe(4141);
    expect(await runCli(["login", "antigravity"], opts)).toBe(1);
    expect(err).toEqual(["error: antigravity is disabled; enable it with acknowledgeTermsRisk: true in router.yaml\n"]);
  });

  test("antigravity end to end in process: browser login over the real loopback, account, models, quota", async () => {
    const { opts, out, err, transport, browser } = options();
    writeFileSync(join(home!, "router.yaml"), BOTH);
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
    expect(readFileSync(join(home!, "logs", "router.log"), "utf8")).toContain("INFO antigravity: signed in account me@x");
  });

  test("an invalid router.yaml is reported, not thrown", async () => {
    const { opts, err } = options();
    writeFileSync(join(home!, "router.yaml"), "providers:\n  antigravity: {enabled: true}\n");
    expect(await runCli(["help"], opts)).toBe(1);
    expect(err[0]).toContain("enabled without acknowledgeTermsRisk: true");
    writeFileSync(join(home!, "router.yaml"), "port: [1, 2\n");
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

  test("default home: INFERENCE_ROUTER_HOME, else ~/.local/share/inference-router", async () => {
    const { homedir } = await import("node:os");
    expect(defaultHome({ INFERENCE_ROUTER_HOME: "X:/h" })).toBe("X:/h");
    expect(defaultHome({})).toBe(join(homedir(), ".local", "share", "inference-router"));
  });
});

describe("process entry (main/cli.ts)", () => {
  test("maps argv and the environment onto the CLI and sets the exit code", async () => {
    home = makeTemporary("router-entry");
    const saved = { argv: process.argv, env: process.env["INFERENCE_ROUTER_HOME"], write: process.stdout.write, ewrite: process.stderr.write, exitCode: process.exitCode };
    const printed: string[] = [];
    const errors: string[] = [];
    process.argv = [process.argv[0]!, "cli.ts", "help"];
    process.env["INFERENCE_ROUTER_HOME"] = home;
    process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await import("@inference-router/router/main/cli.ts");
      expect(process.exitCode).toBe(0);
      const { main } = await import("@inference-router/router/composition/container.ts");
      expect(await main(["frobnicate"])).toBe(2);
      expect(errors.join("")).toContain("unknown command frobnicate");
    } finally {
      process.argv = saved.argv;
      process.stdout.write = saved.write;
      process.stderr.write = saved.ewrite;
      process.exitCode = saved.exitCode;
      if (saved.env === undefined) delete process.env["INFERENCE_ROUTER_HOME"];
      else process.env["INFERENCE_ROUTER_HOME"] = saved.env;
    }
    expect(printed.join("")).toContain("usage: inference-router <command>");
  });
});

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
      const { opts, out, err } = options({ seams, shutdown, transport: undefined as never });
      const { transport: _scripted, ...real } = opts;
      const port = await freePort();
      writeFileSync(join(home!, "router.yaml"), `port: ${port}\n${BOTH}`);
      expect(await runCli(["login", "antigravity", "--timeout-seconds", "10"], real)).toBe(0);
      expect(await runCli(["status"], real)).toBe(1);
      expect(out.at(-1)).toMatch(new RegExp(`^not running at http://127\\.0\\.0\\.1:${port} \\(`));

      const serving = runCli(["serve"], real);
      for (let i = 0; i < 200 && !out.some((l) => l.startsWith("inference-router listening")); i++) await Bun.sleep(10);
      expect(out).toContain(`inference-router listening on http://127.0.0.1:${port} (providers: claude, antigravity)\n`);
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
      expect(listed.headers.get("x-router-models-source")).toBe("claude=static,antigravity=live");

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
    expect(seamsFrom({ INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API: "http://127.0.0.1:5001", INFERENCE_ROUTER_TEST_UPSTREAM_GOOGLE_OAUTH: "http://127.0.0.1:5002/" })).toEqual({
      claudeApi: "http://127.0.0.1:5001",
      googleOAuth: "http://127.0.0.1:5002",
    });
    for (const value of ["https://127.0.0.1:1", "http://localhost:1", "http://127.0.0.1:1/v1", "http://127.0.0.1:1/?x=1", "not a url", "http://api.anthropic.com"]) {
      expect(() => seamsFrom({ INFERENCE_ROUTER_TEST_UPSTREAM_ANTIGRAVITY_API: value })).toThrow("INFERENCE_ROUTER_TEST_UPSTREAM_ANTIGRAVITY_API must be an http://127.0.0.1:<port> origin");
    }
  });

  test("main refuses a seam that is not loopback before building anything", async () => {
    const saved = { ewrite: process.stderr.write, env: process.env["INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH"] };
    const errors: string[] = [];
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    process.env["INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH"] = "https://claude.com";
    try {
      const { main } = await import("@inference-router/router/composition/container.ts");
      expect(await main(["help"])).toBe(1);
      expect(errors.join("")).toBe('error: INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH must be an http://127.0.0.1:<port> origin (hermetic tests only), got "https://claude.com"\n');
    } finally {
      process.stderr.write = saved.ewrite;
      if (saved.env === undefined) delete process.env["INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH"];
      else process.env["INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH"] = saved.env;
    }
  });
});
