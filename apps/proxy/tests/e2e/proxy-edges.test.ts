// Proxy edge paths, black-box: request bodies over the limit, unmatched routes, client disconnects and slow readers,
// shutdown with a response still streaming, the upstream idle timeout, listen errors, other platforms' browser
// openers, refused or odd logins, disabled providers, aliases and addresses, missing or odd stored files, and the
// process environment (default data directory, partial seams, hermetic hook validation).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { accountsFile, BOTH_PROVIDERS, logFiles, makeHome, runProxy, startDaemon, usageOf, type Daemon, type Home, proxyLogOf, loggedEventually } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams, stalledStream } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(60_000);
const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
let daemon: Daemon | undefined;
let scratch: string | undefined;
afterEach(async () => {
  upstreams.reset();
  if (daemon !== undefined) await daemon.stop();
  daemon = undefined;
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
  if (scratch !== undefined) removeTemporary(scratch);
  scratch = undefined;
});

const MESSAGES = "/v1/messages";
const CLAUDE_ONLY = "providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n";
const run = (argv: string[], env: Record<string, string> = {}, input?: (stdout: () => string) => Promise<string>) => runProxy(home!, argv, { ...upstreams.seamEnv(), ...env }, input);
async function login(provider: "claude" | "antigravity", env: Record<string, string> = {}): Promise<void> {
  const result = await run(["login", provider, "--timeout-seconds", "30"], env);
  if (result.code !== 0) throw new Error(result.stderr);
}
type Session = { url: string; token: string };
async function serve(env: Record<string, string> = {}): Promise<Session> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, { ...upstreams.seamEnv(), ...env });
  return { url: daemon.url, token };
}
const auth = (s: Session) => ({ "x-api-key": s.token });
const claudeBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: "claude/claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: "hi" }], ...extra });
const proxyLog = () => proxyLogOf(home!);
const errorOf = async (res: Response) => ((await res.json()) as { error: { type?: string; status?: string; message: string } }).error;
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** A request body sent in chunks without a content-length (chunked transfer). */
function chunkedBody(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

describe("HTTP edges", () => {
  test("bodies over 32 MB are refused, by their declared length or while being read; a chunked body within the limit is read", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const s = await serve();
    const declared = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: " ".repeat(32_000_001) });
    expect([declared.status, await errorOf(declared)]).toEqual([413, { type: "request_too_large", message: "request body exceeds 32000000 bytes" }]);
    const streamed = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: chunkedBody(33, 1_000_000) });
    expect(streamed.status).toBe(413);
    await streamed.text();
    const small = claudeBody();
    const fits = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: new Blob([small]).stream() });
    expect(fits.status).toBe(200);
    await fits.text();
  });

  test("logs.maxFileMegabytes: past the size a new usage file starts; after SIGTERM every record is on disk and whole (L2, L3a, L6)", async () => {
    home = await makeHome(`logs: {maxFileMegabytes: 1}\n${CLAUDE_ONLY}`);
    await login("claude");
    const s = await serve();
    const big = claudeBody({ system: "s".repeat(400_000) });
    for (let i = 0; i < 4; i++) {
      const answer = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: big });
      expect(answer.status).toBe(200);
      await answer.text();
    }
    const stopped = await daemon!.stop();
    daemon = undefined;
    expect(stopped.code).toBe(0);
    const files = logFiles(home, "usage");
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((name) => /-usage\.1\.jsonl$/.test(name))).toBe(true);
    const records = usageOf(home);
    expect(records.filter((r) => r["kind"] === "client-request")).toHaveLength(4);
    expect(records.filter((r) => r["kind"] === "client-response")).toHaveLength(4);
  });

  test("unmatched routes are 404s in the dialect's shape; a request without a token is a 401", async () => {
    home = await makeHome(BOTH_PROVIDERS);
    const s = await serve();
    const geminiOther = await fetch(`${s.url}/gemini/v1beta/other`, { method: "POST", headers: { "x-goog-api-key": s.token }, body: "{}" });
    expect([geminiOther.status, (await errorOf(geminiOther)).message]).toEqual([404, "no route POST /gemini/v1beta/other"]);
    const geminiGet = await fetch(`${s.url}/gemini/v1beta/models/x:generateContent`, { headers: { "x-goog-api-key": s.token } });
    expect([geminiGet.status, (await errorOf(geminiGet)).message]).toEqual([404, "no route GET /gemini/v1beta/models/x:generateContent"]);
    const openaiOther = await fetch(`${s.url}/openai/v1/embeddings`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: "{}" });
    expect([openaiOther.status, (await errorOf(openaiOther)).message]).toEqual([404, "no route POST /openai/v1/embeddings"]);
    const malformed = await fetch(`${s.url}/gemini/v1beta/models/%E0%A4%A:generateContent`, { method: "POST", headers: { "x-goog-api-key": s.token }, body: "{}" });
    expect([malformed.status, (await errorOf(malformed)).message]).toEqual([400, 'malformed model segment "%E0%A4%A"']);
    const anonymous = await fetch(`${s.url}/anthropic/v1/models`);
    expect([anonymous.status, (await errorOf(anonymous)).type]).toEqual([401, "authentication_error"]);
  });

  test("a client that goes away while the upstream is silent cancels it, and nothing is reported", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const s = await serve();
    let cancelled = false;
    upstreams.script(MESSAGES, () => stalledStream('event: ping\ndata: {"type":"ping"}\n\n', () => (cancelled = true)));
    const controller = new AbortController();
    const res = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody({ stream: true }), signal: controller.signal });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ping");
    controller.abort();
    await until(() => cancelled, "the upstream cancel");
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(proxyLog()).not.toContain("response stream failed");
  });

  test("a slow reader gets back-pressure, and disconnecting while the proxy waits for it cancels the upstream", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const s = await serve();
    let produced = 0;
    let cancelled = false;
    const event = new TextEncoder().encode(`event: ping\ndata: {"type":"ping","pad":"${"x".repeat(256 * 1024)}"}\n\n`);
    upstreams.script(MESSAGES, () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (produced > 400) return controller.close();
            produced++;
            controller.enqueue(event);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const body = claudeBody({ stream: true });
    const socket = connect(home.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.pause();
    socket.write(`POST /anthropic${MESSAGES} HTTP/1.1\r\nhost: 127.0.0.1\r\nx-api-key: ${s.token}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await until(() => produced > 20, "the upstream to produce");
    await Bun.sleep(300);
    const stalledAt = produced;
    expect(stalledAt).toBeLessThan(400);
    socket.destroy();
    await until(() => cancelled, "the upstream cancel");
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(proxyLog()).not.toContain("response stream failed");
  });

  test("frames already received when a slow reader disconnects are not written", async () => {
    home = await makeHome(BOTH_PROVIDERS);
    await login("antigravity");
    const s = await serve();
    let cancelled = false;
    // 1 KiB events, so every network read the proxy gets holds many frames: the one after the stalled write is
    // already decoded when the reader goes away.
    const event = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "y".repeat(1024) }] } }] } })}\n\n`;
    const payload = new TextEncoder().encode(event.repeat(24_000));
    upstreams.script("/v1internal:streamGenerateContent", () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(payload), cancel: () => void (cancelled = true) }), { headers: { "content-type": "text/event-stream" } }),
    );
    const socket = connect(home.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.pause();
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    socket.write(`POST /gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:streamGenerateContent?alt=sse HTTP/1.1\r\nhost: 127.0.0.1\r\nx-goog-api-key: ${s.token}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await until(() => upstreams.find("/v1internal:streamGenerateContent").length > 0, "the upstream call");
    await Bun.sleep(1_000);
    socket.destroy();
    await until(() => cancelled, "the upstream cancel");
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(proxyLog()).not.toContain("response stream failed");
  });

  test("SIGTERM with a response still streaming: the server waits the grace period, then cuts it and exits 0", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const s = await serve();
    upstreams.script(MESSAGES, () => stalledStream('event: ping\ndata: {"type":"ping"}\n\n', () => undefined));
    const res = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody({ stream: true }) });
    const reader = res.body!.getReader();
    await reader.read();
    const started = performance.now();
    const stopped = await daemon!.stop();
    daemon = undefined;
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("SIGTERM: stopping (in-flight responses get 10 s)");
    expect(performance.now() - started).toBeGreaterThan(9_000);
    await reader.read().catch(() => undefined);
  });

  // Bun 1.4.2 checks the fetch idle timer coarsely: a 500 ms or 3 s idle timeout fired after ~8 s (measured
  // 2026-10-11, docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md), so the silent upstream waits longer than that.
  test("hook: the upstream idle timeout is a 504 before the headers and ends a stream that went quiet", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const s = await serve({ ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS: "500" });
    upstreams.script(MESSAGES, async () => {
      await Bun.sleep(15_000);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const silent = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody() });
    expect([silent.status, (await errorOf(silent)).message]).toEqual([504, `upstream ${new URL(upstreams.origin).host} sent nothing for 500 ms`]);
    upstreams.script(MESSAGES, () => stalledStream('event: ping\ndata: {"type":"ping"}\n\n', () => undefined));
    const quiet = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody({ stream: true }) });
    expect(quiet.status).toBe(200);
    expect(await quiet.text()).toContain("ping");
    await until(() => proxyLog().includes("response stream failed"), "the stream failure report");
    expect(await loggedEventually(home!, "sent nothing for 500 ms")).toContain("sent nothing for 500 ms");
  });

  test("hook: an address the OS cannot bind is fatal with the OS error", async () => {
    home = await makeHome(CLAUDE_ONLY);
    const refused = await run(["serve"], { ACCOUNTS_PROXY_TEST_LISTEN_UNASSIGNED: "1" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("EADDRNOTAVAIL");
  });
});

describe("logins", () => {
  test("hook: other platforms' openers are not found here; the login then waits and times out", async () => {
    home = await makeHome(CLAUDE_ONLY);
    for (const platform of ["win32", "darwin"]) {
      const result = await run(["login", "claude", "--timeout-seconds", "1"], { ACCOUNTS_PROXY_TEST_PLATFORM: platform, PATH: home.bin });
      expect([result.code, result.stderr]).toEqual([1, "error: no browser callback within 1 s\n"]);
    }
    expect(proxyLog().match(/WARN claude: could not open the browser/g)).toHaveLength(2);
  });

  test("a refusal without a description; paste-code without a state, with a wrong state, or empty", async () => {
    home = await makeHome(CLAUDE_ONLY);
    const denied = await run(["login", "claude", "--timeout-seconds", "30"], { ACCOUNTS_PROXY_E2E_BROWSER_MODE: "deny-bare" });
    expect([denied.code, denied.stderr]).toEqual([1, "error: claude: authorization failed: access_denied; run `accounts-proxy login claude`\n"]);
    const paste = (answer: (state: string) => string) =>
      run(["login", "claude", "--manual"], {}, async (stdout) => {
        for (let i = 0; i < 3000 && !stdout().includes("code> "); i++) await Bun.sleep(10);
        const url = new URL(stdout().split("\n").find((l) => l.startsWith("http"))!);
        return `${answer(url.searchParams.get("state")!)}\n`;
      });
    expect((await paste(() => "e2e-code")).code).toBe(0);
    expect((await paste(() => "e2e-code#forged")).stderr).toBe("error: claude: authorization state mismatch; run `accounts-proxy login claude`\n");
    expect((await paste(() => "   ")).stderr).toBe("error: claude: no authorization code entered; run `accounts-proxy login claude`\n");
  });
});

describe("configuration and stored files", () => {
  test("a disabled provider: its models, quota and requests are refused", async () => {
    home = await makeHome(CLAUDE_ONLY);
    expect((await run(["models", "antigravity"])).stderr).toBe("error: antigravity is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n");
    expect((await run(["quota", "antigravity"])).stderr).toBe("error: antigravity is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n");
    const s = await serve();
    const routed = await fetch(`${s.url}/gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:generateContent`, { method: "POST", headers: { "x-goog-api-key": s.token }, body: "{}" });
    expect([routed.status, (await errorOf(routed)).message]).toEqual([503, "antigravity is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml"]);
  });

  test("aliases resolve to their target; addresses with an unknown provider or an empty model are unknown models", async () => {
    home = await makeHome(`${CLAUDE_ONLY}aliases:\n  fast: claude/claude-opus-4-8\n`);
    await login("claude");
    const s = await serve();
    const aliased = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody({ model: "fast" }) });
    expect(aliased.status).toBe(200);
    await aliased.text();
    expect((JSON.parse(upstreams.find(MESSAGES).at(-1)!.body) as { model: string }).model).toBe("claude-opus-4-8");
    for (const model of ["nope/x", "claude/ ", "slow"]) {
      const unknown = await fetch(`${s.url}/anthropic${MESSAGES}`, { method: "POST", headers: auth(s), body: claudeBody({ model }) });
      expect([unknown.status, (await errorOf(unknown)).type]).toEqual([404, "not_found_error"]);
    }
    writeFileSync(join(home.dir, "proxy.yaml"), `port: ${home.port}\n${CLAUDE_ONLY}aliases:\n  bad: nonsense\n`);
    expect((await run(["models", "claude"])).stderr).toContain('aliases.bad = "nonsense" is not <provider>/<model>');
  });

  test("no proxy.yaml disables every provider; a daemon without providers lists no models", async () => {
    home = await makeHome("");
    const listed = await fetch(`${(await serve()).url}/anthropic/v1/models`, { headers: { "x-api-key": (await run(["token"])).stdout.trim() } });
    expect(await listed.json()).toEqual({ data: [], first_id: null, has_more: false, last_id: null });
    rmSync(join(home.dir, "proxy.yaml"));
    expect((await run(["models", "claude"])).stderr).toBe("error: claude is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n");
  });

  test("an accounts file and a token file with a BOM are read; an accounts file that is a directory is an error", async () => {
    home = await makeHome(CLAUDE_ONLY);
    await login("claude");
    const token = (await run(["token"])).stdout;
    writeFileSync(join(home.dir, "token.json"), `\uFEFF${readFileSync(join(home.dir, "token.json"), "utf8")}`);
    expect(await run(["token"])).toEqual({ code: 0, stdout: token, stderr: "" });
    const file = accountsFile(home);
    writeFileSync(file, `\uFEFF${readFileSync(file, "utf8")}`);
    expect((await run(["account", "list", "claude"])).code).toBe(0);
    rmSync(file);
    mkdirSync(file);
    const broken = await run(["account", "list", "claude"]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("EISDIR");
  });
});

describe("process environment", () => {
  test("without ACCOUNTS_PROXY_HOME the data directory is under HOME; partial seams leave the other hosts as they are", async () => {
    home = await makeHome(CLAUDE_ONLY);
    scratch = makeTemporary("proxy-home");
    const defaults = await runProxy(home, ["models", "claude"], { ACCOUNTS_PROXY_HOME: "", HOME: scratch });
    expect([defaults.code, defaults.stderr]).toEqual([1, "error: claude is disabled; enable it with acknowledgeTermsRisk: true in proxy.yaml\n"]);
    mkdirSync(join(scratch, ".local", "share", "accounts-proxy"), { recursive: true });
    writeFileSync(join(scratch, ".local", "share", "accounts-proxy", "proxy.yaml"), BOTH_PROVIDERS);
    expect((await runProxy(home, ["account", "list", "claude"], { ACCOUNTS_PROXY_HOME: "", HOME: scratch })).code).toBe(0);
    // The openai provider on its production hosts (no seam set; listing accounts calls no host).
    writeFileSync(join(scratch, ".local", "share", "accounts-proxy", "proxy.yaml"), "providers:\n  openai: {enabled: true, acknowledgeTermsRisk: true}\n");
    expect(await runProxy(home, ["account", "list", "openai"], { ACCOUNTS_PROXY_HOME: "", HOME: scratch })).toMatchObject({ code: 0, stdout: "no openai accounts; run: bun run proxy login openai\n" });
    for (const seam of ["ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API", "ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API"]) {
      const partial = await runProxy(home, ["help"], { [seam]: upstreams.origin });
      expect([partial.code, partial.stderr]).toEqual([0, ""]);
    }
  });

  test("hook variables are refused without every seam, and validated; a seam that is not a URL is refused", async () => {
    home = await makeHome(CLAUDE_ONLY);
    const notUrl = await runProxy(home, ["help"], { ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API: "::" });
    expect([notUrl.code, notUrl.stderr]).toEqual([1, 'error: ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API must be an http://127.0.0.1:<port> origin (hermetic tests only), got "::"\n']);
    const lone = await runProxy(home, ["help"], { ACCOUNTS_PROXY_TEST_PLATFORM: "linux" });
    expect([lone.code, lone.stderr]).toEqual([1, "error: ACCOUNTS_PROXY_TEST_PLATFORM need every ACCOUNTS_PROXY_TEST_UPSTREAM_* seam (hermetic tests only)\n"]);
    for (const [name, value, reason] of [
      ["ACCOUNTS_PROXY_TEST_PLATFORM", "aix", "must be one of linux, darwin, win32"],
      ["ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS", "soon", "must be a positive integer (milliseconds)"],
      ["ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS", "0", "must be a positive integer (milliseconds)"],
      ["ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES", "yes", "must be 1"],
    ] as const) {
      const refused = await run(["help"], { [name]: value });
      expect([refused.code, refused.stderr]).toEqual([1, `error: ${name} ${reason}\n`]);
    }
  });
});
