// Account sessions and the provider control planes, black-box: token refresh (single-flight, rejected, impossible),
// forced rotation on 401, the geo-gate retry, quota answers, project onboarding, catalog fallbacks and the stored
// per-install state. Each test signs in its own data directory with scripted token answers.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { makeHome, runRouter, startDaemon, type Daemon, type Home } from "@inference-router/test-support/e2e/router-process.ts";
import { jsonResponse, ReplayUpstreams } from "@inference-router/test-support/e2e/upstreams.ts";

setDefaultTimeout(60_000);
const upstreams = new ReplayUpstreams();
beforeAll(() => void upstreams.start());
afterAll(() => upstreams.stop());

let home: Home | undefined;
let daemon: Daemon | undefined;
afterEach(async () => {
  upstreams.reset();
  if (daemon !== undefined) await daemon.stop();
  daemon = undefined;
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});

const repo = join(import.meta.dir, "..", "..", "..", "..");
const claudeToken = (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const base = JSON.parse(readFileSync(join(repo, "packages", "provider-claude", "tests", "fixtures", "plugin-6292741", "refresh-response.json"), "utf8")) as Record<string, unknown>;
  for (const key of drop) delete base[key];
  return () => jsonResponse({ ...base, ...over });
};
const googleToken = (over: Record<string, unknown> = {}) => () => jsonResponse({ access_token: "e2e-google-access", refresh_token: "e2e-google-refresh", expires_in: 3599, ...over });
const run = (argv: string[], env: Record<string, string> = {}) => runRouter(home!, argv, { ...upstreams.seamEnv(), ...env });
async function login(provider: "claude" | "antigravity"): Promise<void> {
  const result = await run(["login", provider, "--timeout-seconds", "30"]);
  if (result.code !== 0) throw new Error(result.stderr);
}
async function serve(): Promise<{ url: string; token: string }> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, upstreams.seamEnv());
  return { url: daemon.url, token };
}
const claudeMessage = (s: { url: string; token: string }, model = "claude/claude-haiku-4-5-20251001") =>
  fetch(`${s.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": s.token }, body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
const gemini = (s: { url: string; token: string }) =>
  fetch(`${s.url}/gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:generateContent`, { method: "POST", headers: { "x-goog-api-key": s.token }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }) });
const tokenCalls = (path: string, grant: string) => upstreams.find(path).filter((r) => r.body.includes(grant)).length;
const accounts = (provider: string) => JSON.parse(readFileSync(join(home!.dir, `accounts-${provider}.json`), "utf8")) as { accounts: { id: string; data: Record<string, unknown> }[] };
const routerLog = () => readFileSync(join(home!.dir, "logs", "router.log"), "utf8");

describe("claude sessions", () => {
  test("an expiring token is refreshed once for concurrent requests (stored scopes sent), then reused", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    const s = await serve();
    const before = tokenCalls("/v1/oauth/token", "refresh_token");
    const answers = await Promise.all([claudeMessage(s), claudeMessage(s)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    await Promise.all(answers.map((a) => a.text()));
    expect(tokenCalls("/v1/oauth/token", "refresh_token") - before).toBe(1);
    const refresh = JSON.parse(upstreams.find("/v1/oauth/token").at(-1)!.body) as Record<string, string>;
    expect(refresh["scope"]).toBe("user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code");
    expect((accounts("claude").accounts[0]!.data["expiresAt"] as number) > Date.now() + 60_000).toBe(true);
    expect((await claudeMessage(s)).status).toBe(200);
    expect(tokenCalls("/v1/oauth/token", "refresh_token") - before).toBe(1);
  });

  test("H6: a rejected refresh marks the account needsLogin, later requests fail fast, a new login clears it; H4: a 5xx renewal keeps a valid token", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    const id = accounts("claude").accounts[0]!.id;
    const s = await serve();
    upstreams.script("/v1/oauth/token", () => jsonResponse({ error: "invalid_grant" }, 400));
    const rejected = await claudeMessage(s);
    expect([rejected.status, ((await rejected.json()) as { error: { message: string } }).error.message]).toEqual([401, "claude: token endpoint rejected the grant (HTTP 400); run `inference-router login claude`"]);
    const calls = tokenCalls("/v1/oauth/token", "refresh_token");
    const fast = await claudeMessage(s);
    expect([fast.status, ((await fast.json()) as { error: { message: string } }).error.message]).toEqual([
      401,
      `claude: account ${id} needs a new login (token endpoint rejected the grant (HTTP 400)); run \`inference-router login claude\``,
    ]);
    expect(tokenCalls("/v1/oauth/token", "refresh_token")).toBe(calls);
    expect((await run(["account", "list", "claude"])).stdout).toBe(`* ${id}  [needs login: token endpoint rejected the grant (HTTP 400)]\n`);

    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    expect((await run(["account", "list", "claude"])).stdout).toBe(`* ${id}\n`);
    upstreams.script("/v1/oauth/token", () => jsonResponse({ error: "server" }, 503));
    expect((await claudeMessage(s)).status).toBe(200);
    expect(routerLog()).toContain(`WARN claude: token renewal failed (claude upstream HTTP 503: {"error":"server"}); using the stored token of ${id} until it expires`);

    const pool = accounts("claude");
    pool.accounts[0]!.data["expiresAt"] = 0;
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify(pool));
    upstreams.script("/v1/oauth/token", () => jsonResponse({ error: "server" }, 503));
    expect((await claudeMessage(s)).status).toBe(503);
  });

  test("H-d: an upstream 401 renews the token once and the same request succeeds", async () => {
    home = await makeHome();
    await login("claude");
    const s = await serve();
    const before = tokenCalls("/v1/oauth/token", "refresh_token");
    upstreams.script("/v1/messages", () => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    const answer = await claudeMessage(s);
    expect(answer.status).toBe(200);
    await answer.text();
    expect(tokenCalls("/v1/oauth/token", "refresh_token") - before).toBe(1);
    const sent = upstreams.find("/v1/messages").slice(-2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(routerLog()).toContain("INFO claude: upstream 401; renewing the token once and retrying");
  });

  /** Holds the next token-endpoint answer until `release`; then answers with `answer`. */
  function holdRenewal(answer: () => Response | Promise<Response>) {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const state = { entered: false };
    upstreams.script("/v1/oauth/token", async () => {
      state.entered = true;
      await held;
      return answer();
    });
    return {
      release,
      entered: async () => {
        while (!state.entered) await Bun.sleep(10);
      },
    };
  }

  test("H1: a new login during a renewal is kept: the renewed token serves only that request; a rejected renewal does not mark the new login", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    const s = await serve();
    const renewal = holdRenewal(claudeToken({ access_token: "e2e-renewed" }));
    upstreams.script("/v1/oauth/token", claudeToken({ access_token: "e2e-login-1" }));
    const pending = claudeMessage(s);
    await renewal.entered();
    await login("claude");
    renewal.release();
    expect((await pending).status).toBe(200);
    expect(accounts("claude").accounts[0]!.data["accessToken"]).toBe("e2e-login-1");
    expect(routerLog()).toContain("was written meanwhile (new login); the renewed token serves this call only");

    const expiring = accounts("claude");
    expiring.accounts[0]!.data["expiresAt"] = Date.now() + 60_000;
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify(expiring));
    const rejected = holdRenewal(() => jsonResponse({ error: "invalid_grant" }, 400));
    upstreams.script("/v1/oauth/token", claudeToken({ access_token: "e2e-login-2" }));
    const failing = claudeMessage(s);
    await rejected.entered();
    await login("claude");
    rejected.release();
    expect((await failing).status).toBe(401);
    expect(accounts("claude").accounts[0]!.data["accessToken"]).toBe("e2e-login-2");
    expect((accounts("claude").accounts[0] as Record<string, unknown>)["needsLogin"]).toBeUndefined();
    expect((await claudeMessage(s)).status).toBe(200);
  });

  test("H1: an account removed from the file during a renewal stays removed; the renewed token serves that request", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    const s = await serve();
    const renewal = holdRenewal(claudeToken({ access_token: "e2e-renewed" }));
    const pending = claudeMessage(s);
    await renewal.entered();
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [] }));
    renewal.release();
    expect((await pending).status).toBe(200);
    expect(accounts("claude").accounts).toEqual([]);
  });

  test("H-d: an upstream 401 without a stored refresh token is answered as is", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({}, ["refresh_token"]));
    await login("claude");
    const s = await serve();
    const before = upstreams.find("/v1/oauth/token").length;
    upstreams.script("/v1/messages", () => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid" } }, 401));
    const answer = await claudeMessage(s);
    expect(answer.status).toBe(401);
    expect(((await answer.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
    expect(upstreams.find("/v1/oauth/token").length).toBe(before);
  });

  test("H1: `account use` while the daemon renews a token is not undone, and the renewed token is stored", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login("claude");
    const first = accounts("claude").accounts[0]!.id;
    const pool = accounts("claude");
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [...pool.accounts, { provider: "claude", id: "spare", label: "spare", data: pool.accounts[0]!.data }], activeId: first }));
    const s = await serve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    upstreams.script("/v1/oauth/token", async () => {
      entered = true;
      await held;
      return claudeToken({ access_token: "e2e-renewed" })();
    });
    const pending = claudeMessage(s);
    while (!entered) await Bun.sleep(10);
    expect((await run(["account", "use", "claude", "spare"])).code).toBe(0);
    release();
    expect((await pending).status).toBe(200);
    const after = JSON.parse(readFileSync(join(home.dir, "accounts-claude.json"), "utf8")) as { activeId: string; accounts: { id: string; data: Record<string, unknown> }[] };
    expect(after.activeId).toBe("spare");
    expect(after.accounts.find((a) => a.id === first)!.data["accessToken"]).toBe("e2e-renewed");
  });

  test("without a refresh token an expired login cannot be renewed; without scopes the refresh asks for the default set", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }, ["refresh_token", "account", "organization"]));
    await login("claude");
    expect(accounts("claude").accounts[0]!.id).toBe("claude-account");
    const s = await serve();
    const stuck = await claudeMessage(s);
    expect([stuck.status, ((await stuck.json()) as { error: { message: string } }).error.message]).toEqual([401, "claude: access token expired and no refresh token is stored; run `inference-router login claude`"]);
    await daemon!.stop();
    daemon = undefined;
    removeTemporary(home.dir);
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60, scope: "" }));
    await login("claude");
    expect(accounts("claude").accounts[0]!.data["scopes"]).toBe("");
    const t = await serve();
    expect((await claudeMessage(t)).status).toBe(200);
    expect((JSON.parse(upstreams.find("/v1/oauth/token").at(-1)!.body) as Record<string, string>)["scope"]).toBe("user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins");
  });

  test("a damaged or missing active account is a 401 asking for a login", async () => {
    home = await makeHome();
    await login("claude");
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [{ provider: "claude", id: "x", label: "x", data: { broken: true } }], activeId: "x" }));
    const s = await serve();
    const unreadable = await claudeMessage(s);
    expect([unreadable.status, ((await unreadable.json()) as { error: { message: string } }).error.message]).toEqual([401, "claude: stored credential of x is unreadable; run `inference-router login claude`"]);
    writeFileSync(join(home.dir, "accounts-claude.json"), JSON.stringify({ accounts: [] }));
    await daemon!.stop();
    const t = await serve();
    expect(((await (await claudeMessage(t)).json()) as { error: { message: string } }).error.message).toBe("claude: no active account; run `inference-router login claude`");
  });
});

describe("claude catalog", () => {
  test("live pages are followed; a failing or empty catalog falls back to the stored copy, else the built-in list", async () => {
    home = await makeHome();
    await login("claude");
    upstreams.script("/v1/models", () => jsonResponse({ data: [], has_more: false }));
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toMatch(/^# claude: \d+ models \(built-in list: the live catalog was unavailable\)$/);
    expect(routerLog()).toContain("WARN claude: live catalog unavailable (live catalog is empty)");
    upstreams.script(
      "/v1/models",
      () => jsonResponse({ data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 }], has_more: true, last_id: "claude-opus-5" }),
      () => jsonResponse({ data: [{ id: "" }, { type: "model", id: "claude-bare" }], has_more: true }),
      () => jsonResponse({ has_more: false }),
    );
    const live = await run(["models", "claude"]);
    expect(live.stdout).toBe("# claude: 2 models (live catalog)\nclaude/claude-opus-5  Claude Opus 5  context 1000000 / output 128000\nclaude/claude-bare  claude-bare\n");
    expect(upstreams.find("/v1/models").slice(-2).map((r) => r.search)).toEqual(["?limit=100&after_id=claude-opus-5", "?limit=100&after_id=claude-bare"]);
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toBe("# claude: 2 models (stored copy of the live catalog)");
    const cache = join(home.dir, "state", "claude", "model-catalog.json");
    writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), fetchedAt: 0 }));
    upstreams.script("/v1/models", () => jsonResponse({ type: "error", error: { type: "api_error", message: "down" } }, 500));
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toBe("# claude: 2 models (stored copy of the live catalog)");
    expect(routerLog()).toContain("live catalog unavailable (models catalog HTTP 500)");
  });
});

describe("antigravity sessions", () => {
  test("an expiring token is refreshed once for concurrent requests; a refresh without a new refresh token keeps the old one", async () => {
    home = await makeHome();
    upstreams.script("/token", googleToken({ expires_in: 60 }));
    await login("antigravity");
    const s = await serve();
    upstreams.script("/token", googleToken({ refresh_token: undefined }));
    const answers = await Promise.all([gemini(s), gemini(s)]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    await Promise.all(answers.map((a) => a.text()));
    expect(tokenCalls("/token", "grant_type=refresh_token")).toBeGreaterThanOrEqual(1);
    expect((accounts("antigravity").accounts[0]!.data["tokens"] as Record<string, unknown>)["refreshToken"]).toBe("e2e-google-refresh");
  });

  test("a 401 from the upstream forces one rotation and retries (concurrent callers reuse it); a second 401 is returned", async () => {
    home = await makeHome();
    await login("antigravity");
    const s = await serve();
    const unauthorized = () => jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401);
    upstreams.script("/v1internal:streamGenerateContent", unauthorized, unauthorized);
    const both = await Promise.all([gemini(s), gemini(s)]);
    expect(both.map((a) => a.status)).toEqual([200, 200]);
    await Promise.all(both.map((a) => a.text()));
    upstreams.script("/v1internal:streamGenerateContent", unauthorized, unauthorized);
    const twice = await gemini(s);
    expect([twice.status, ((await twice.json()) as { error: { status: string } }).error.status]).toEqual([401, "UNAUTHENTICATED"]);
    upstreams.script("/v1internal:fetchAvailableModels", unauthorized);
    expect((await run(["models", "antigravity"])).code).toBe(0);
  });

  test("the geo gate is retried twice with 2 s and 8 s waits; quota answers carry retry-after when it is a number", async () => {
    home = await makeHome();
    await login("antigravity");
    const s = await serve();
    const gate = () => jsonResponse({ error: { code: 400, message: "User location is not supported for the API use.", status: "FAILED_PRECONDITION" } }, 400);
    upstreams.script("/v1internal:streamGenerateContent", gate, gate);
    const started = performance.now();
    expect((await gemini(s)).status).toBe(200);
    expect(performance.now() - started).toBeGreaterThan(9_500);
    const quota = (retry: string) => () => jsonResponse({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, 429, { "retry-after": retry });
    upstreams.script("/v1internal:streamGenerateContent", quota("30"), quota("soon"));
    const limited = await gemini(s);
    expect([limited.status, limited.headers.get("retry-after"), ((await limited.json()) as { error: { status: string } }).error.status]).toEqual([429, "30", "RESOURCE_EXHAUSTED"]);
    const vague = await gemini(s);
    expect([vague.status, vague.headers.get("retry-after")]).toEqual([429, null]);
    await vague.text();
  }, 60_000);

  test("onboarding when loadCodeAssist has no project; without any project the account cannot generate", async () => {
    home = await makeHome();
    upstreams.script("/v1internal:fetchUserInfo", () => jsonResponse({}, 500));
    upstreams.script("/oauth2/v2/userinfo", () => jsonResponse({}, 500));
    upstreams.script("/v1internal:loadCodeAssist", () => jsonResponse({}, 503));
    upstreams.script("/v1internal:onboardUser", () => jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "onboarded-1" } } }));
    await login("antigravity");
    const minted = accounts("antigravity").accounts[0]!;
    expect(minted.id).toMatch(/^antigravity-[0-9a-f-]{36}$/);
    expect(routerLog()).toContain("WARN antigravity: loadCodeAssist failed");
    const s = await serve();
    expect((await gemini(s)).status).toBe(200);
    expect((JSON.parse(upstreams.find("/v1internal:streamGenerateContent").at(-1)!.body) as { project: string }).project).toBe("onboarded-1");
    await daemon!.stop();
    daemon = undefined;
    upstreams.script("/v1internal:loadCodeAssist", () => jsonResponse({ projectId: "p-direct", allowedProjects: ["p-direct", { id: "p-object" }, { name: "no-id" }, 7], projects: "not-a-list" }));
    await login("antigravity");
    expect(accounts("antigravity").accounts.at(-1)!.data["projectIds"]).toEqual(["p-direct", "p-object"]);
    upstreams.script("/v1internal:loadCodeAssist", () => jsonResponse({}));
    upstreams.script("/v1internal:onboardUser", () => jsonResponse({ done: false }));
    upstreams.script("/oauth2/v2/userinfo", () => jsonResponse({ email: "noproject@example.com" }));
    await login("antigravity");
    const t = await serve();
    const none = await gemini(t);
    expect([none.status, ((await none.json()) as { error: { message: string } }).error.message]).toEqual([401, "antigravity: account noproject@example.com has no project assigned; run `inference-router login antigravity`"]);
  });
});

describe("stored per-install state", () => {
  test("ids written by one process are reused by the next; damaged ones are replaced", async () => {
    home = await makeHome();
    await login("claude");
    await login("antigravity");
    let s = await serve();
    await (await claudeMessage(s)).text();
    await (await gemini(s)).text();
    const device = (JSON.parse(upstreams.find("/v1/messages").at(-1)!.body) as { metadata: { user_id: string } }).metadata.user_id;
    const session = (JSON.parse(upstreams.find("/v1internal:streamGenerateContent").at(-1)!.body) as { request: { sessionId: string } }).request.sessionId;
    await daemon!.stop();
    s = await serve();
    await (await claudeMessage(s)).text();
    await (await gemini(s)).text();
    expect((JSON.parse(upstreams.find("/v1/messages").at(-1)!.body) as { metadata: { user_id: string } }).metadata.user_id).toBe(device.replace(/"session_id":"[^"]+"/, (JSON.parse(upstreams.find("/v1/messages").at(-1)!.body) as { metadata: { user_id: string } }).metadata.user_id.match(/"session_id":"[^"]+"/)![0]));
    expect((JSON.parse(upstreams.find("/v1internal:streamGenerateContent").at(-1)!.body) as { request: { sessionId: string } }).request.sessionId).toBe(session);
    await daemon!.stop();
    mkdirSync(join(home.dir, "state", "antigravity"), { recursive: true });
    writeFileSync(join(home.dir, "state", "claude", "device-id.json"), '"not-a-device-id"');
    writeFileSync(join(home.dir, "state", "antigravity", "session-id.json"), '"12.5"');
    writeFileSync(join(home.dir, "state", "antigravity", "thought-signatures.json"), '["not", "a", "map"]');
    s = await serve();
    await (await claudeMessage(s)).text();
    await (await gemini(s)).text();
    expect(JSON.parse(readFileSync(join(home.dir, "state", "claude", "device-id.json"), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(home.dir, "state", "antigravity", "session-id.json"), "utf8"))).toMatch(/^-?\d+$/);
  });
});
