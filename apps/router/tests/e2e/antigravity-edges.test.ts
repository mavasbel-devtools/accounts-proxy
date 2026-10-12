// Antigravity edge paths, black-box: the upstream shapes the provider must tolerate (SSE framing details, JSON stream
// bodies, bare envelopes, odd catalog and quota answers), login bootstrap variants, damaged stored accounts and state,
// tool schemas and turn shapes, and the cross-process refresh lock (held, stale, timed out, unwritable).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { makeHome, runRouter, startDaemon, type Daemon, type Home } from "@inference-router/test-support/e2e/router-process.ts";
import { envelopeStream, jsonResponse, ReplayUpstreams } from "@inference-router/test-support/e2e/upstreams.ts";

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
  if (home !== undefined) {
    for (const dir of ["locks", join("state", "antigravity")]) if (existsSync(join(home.dir, dir))) chmodSync(join(home.dir, dir), 0o700);
    removeTemporary(home.dir);
  }
  home = undefined;
});

const GENERATE = "/v1internal:streamGenerateContent";
const LOCK = () => join(home!.dir, "locks", "antigravity-refresh.lock");
const run = (argv: string[], env: Record<string, string> = {}) => runRouter(home!, argv, { ...upstreams.seamEnv(), ...env });
const googleToken = (over: Record<string, unknown> = {}) => () => jsonResponse({ access_token: "e2e-google-access", refresh_token: "e2e-google-refresh", expires_in: 3599, ...over });
async function login(): Promise<void> {
  const result = await run(["login", "antigravity", "--timeout-seconds", "30"]);
  if (result.code !== 0) throw new Error(result.stderr);
}
async function serve(env: Record<string, string> = {}): Promise<{ url: string; token: string }> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, { ...upstreams.seamEnv(), ...env });
  return { url: daemon.url, token };
}
async function restart(env: Record<string, string> = {}): Promise<{ url: string; token: string }> {
  await daemon!.stop();
  daemon = undefined;
  return serve(env);
}
type Answer = { status: number; body: Record<string, unknown>; text: string; headers: Headers };
async function generate(s: { url: string; token: string }, body: unknown, method = "generateContent", query = ""): Promise<Answer> {
  const res = await fetch(`${s.url}/gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:${method}${query}`, { method: "POST", headers: { "x-goog-api-key": s.token }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const hello = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
const candidate = (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] });
const texts = (a: Answer) => ((a.body["candidates"] as { content: { parts: { text?: string }[] } }[])[0]!.content.parts.map((p) => p.text ?? "").join(""));
const message = (a: Answer) => (a.body["error"] as { message: string }).message;
const accountsFile = () => join(home!.dir, "accounts-antigravity.json");
const pool = () => JSON.parse(readFileSync(accountsFile(), "utf8")) as { activeId?: string; accounts: { id: string; label: string; data: Record<string, unknown> }[] };
const writePool = (value: unknown) => writeFileSync(accountsFile(), JSON.stringify(value));
const routerLog = () => readFileSync(join(home!.dir, "logs", "router.log"), "utf8");
const lastBearer = () => upstreams.find(GENERATE).at(-1)!.headers["authorization"];
/** Sets fields of the active account's stored tokens (e.g. expiresAt 0 makes the next request refresh). */
function setTokens(tokens: Record<string, unknown>): void {
  const current = pool();
  writePool({ ...current, accounts: current.accounts.map((a) => (a.id === current.activeId ? { ...a, data: { ...a.data, tokens: { ...(a.data["tokens"] as object), ...tokens } } } : a)) });
}
function holdLock(ageMs = 0): void {
  mkdirSync(join(home!.dir, "locks"), { recursive: true });
  writeFileSync(LOCK(), "4242 0\n");
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(LOCK(), then, then);
  }
}
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** A text/event-stream body written in separate chunks (a pause between them keeps the chunk boundaries). */
function chunked(...pieces: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const piece of pieces) {
          controller.enqueue(encoder.encode(piece));
          await Bun.sleep(30);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("stream shapes", () => {
  test("SSE framing: comments, field-only lines, unspaced values, other fields, data-less events, a CR split from its LF, [DONE]", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    upstreams.script(GENERATE, () =>
      chunked(": keep-alive\r\n", "retry\r\nid: 7\r\n\r\n", `event: message\rdata:${JSON.stringify({ response: candidate("framed") })}\r`, "\n\r\n", "data: {oops\n\n", "data: [DONE]\n\n", "data: \n\n"),
    );
    const answer = await generate(s, hello);
    expect([answer.status, texts(answer)]).toEqual([200, "framed"]);
    expect(routerLog()).toContain("WARN antigravity: dropping malformed SSE event (SyntaxError: JSON Parse error");
  });

  test("a bare candidates envelope; a non-object or non-response payload is a 502, or an error element after the first byte", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    upstreams.script(GENERATE, () => new Response(`data: ${JSON.stringify(candidate("bare"))}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect(texts(await generate(s, hello))).toBe("bare");
    upstreams.script(GENERATE, () => new Response('data: {"foo":1}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const foreign = await generate(s, hello);
    expect([foreign.status, message(foreign)]).toEqual([502, 'antigravity upstream HTTP 502: non-response payload: {"foo":1}']);
    upstreams.script(GENERATE, () => new Response(`data: ${JSON.stringify({ response: candidate("first") })}\n\ndata: 5\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const streamed = await generate(s, hello, "streamGenerateContent", "?alt=sse");
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain("first");
    expect(streamed.text).toContain("non-object payload: 5");
  });

  test("JSON stream bodies: one object, non-object elements skipped, a body without a content type read as SSE", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    upstreams.script(GENERATE, () => jsonResponse({ response: candidate("one") }));
    expect(texts(await generate(s, hello))).toBe("one");
    upstreams.script(GENERATE, () => jsonResponse([5, { response: candidate("two") }]));
    expect(texts(await generate(s, hello))).toBe("two");
    expect(routerLog()).toContain("WARN antigravity: dropping non-object JSON stream envelope (number)");
    const untypedBody = new TextEncoder().encode(`data: ${JSON.stringify({ response: candidate("untyped") })}\n\n`);
    upstreams.script(GENERATE, () => new Response(new ReadableStream({ start: (c) => (c.enqueue(untypedBody), c.close()) })));
    const untyped = await generate(s, hello);
    expect([untyped.status, texts(untyped)]).toEqual([200, "untyped"]);
  });
});

describe("control-plane shapes", () => {
  test("catalog: tab and deprecated ids are excluded whatever their shape; missing fields get defaults", async () => {
    home = await makeHome();
    await login();
    upstreams.script("/v1internal:fetchAvailableModels", () =>
      jsonResponse({
        models: { "m-a": { displayName: "Model A", maxTokens: 1000 }, "m-tab": {}, "m-old": {}, "m-gone": {} },
        tabModelIds: ["m-tab", 7],
        deprecatedModelIds: { "m-old": { newModelId: "m-a" }, "m-gone": null },
      }),
    );
    const listed = await run(["models", "antigravity"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("antigravity/m-a  Model A");
    expect(listed.stdout).not.toContain("m-tab");
    expect(listed.stdout).not.toContain("m-old");
    expect(listed.stdout).not.toContain("m-gone");
    upstreams.script("/v1internal:fetchAvailableModels", () => jsonResponse({ tabModelIds: "x", deprecatedModelIds: ["m"] }), () => jsonResponse([1, 2]), () => new Response("not json"));
    for (let i = 0; i < 3; i++) expect((await run(["models", "antigravity"])).stdout.split("\n")[0]).toMatch(/^# antigravity: /);
  });

  test("quota: groups without a model list, buckets with missing fields and unknown windows, no groups at all", async () => {
    home = await makeHome();
    await login();
    upstreams.script("/v1internal:retrieveUserQuotaSummary", () =>
      jsonResponse({
        groups: [
          { displayName: "Gemini", description: "Models: gemini-a, gemini-b", buckets: [{ bucketId: "g5", window: "5h", resetTime: "2026-10-11T12:00:00Z", remainingFraction: 0.25 }, { window: "daily" }, {}] },
          { description: "no model list here" },
          { description: "" },
        ],
      }),
      () => jsonResponse({}),
    );
    const quota = await run(["quota", "antigravity"]);
    expect(quota.stdout).toBe(
      [
        "Antigravity usage:",
        "- Gemini (gemini-a, gemini-b)",
        "    5-hour limit: 25% remaining, resets 2026-10-11T12:00:00Z",
        "    daily: 0% remaining, resets ",
        "    : 0% remaining, resets ",
        "- ",
        "- ",
        "",
      ].join("\n"),
    );
    expect((await run(["quota", "antigravity"])).stdout).toBe("Antigravity usage:\n");
  });
});

describe("login bootstrap", () => {
  test("e-mail from the IDE settings, else from userinfo, else none; odd project and token answers", async () => {
    home = await makeHome();
    upstreams.script("/v1internal:fetchUserInfo", () => jsonResponse({ userSettings: { email: "settings@example.com" } }));
    await login();
    expect(pool().accounts.map((a) => a.id)).toEqual(["settings@example.com"]);

    upstreams.script("/v1internal:fetchUserInfo", () => jsonResponse({ userSettings: "none" }));
    upstreams.script("/oauth2/v2/userinfo", () => jsonResponse({ email: 7 }));
    upstreams.script("/v1internal:loadCodeAssist", () => jsonResponse([]));
    upstreams.script("/v1internal:onboardUser", () => jsonResponse({ response: { cloudaicompanionProject: "flat" } }));
    upstreams.script("/token", googleToken({ expires_in: "3599", refresh_token: undefined }));
    await login();
    const anonymous = pool().accounts.at(-1)!;
    expect(anonymous.id).toMatch(/^antigravity-[0-9a-f-]{36}$/);
    expect(anonymous.data["projectIds"]).toEqual([]);
    expect(anonymous.data["tokens"]).toEqual({ accessToken: "e2e-google-access", expiresAt: expect.any(Number) });

    upstreams.script("/v1internal:loadCodeAssist", () => jsonResponse({}));
    upstreams.script("/v1internal:onboardUser", () => jsonResponse({ response: { cloudaicompanionProject: { id: 5 } } }));
    upstreams.script("/token", googleToken({ expires_in: undefined }));
    await login();
    expect(pool().accounts.at(-1)!.data["projectIds"]).toEqual([]);

    upstreams.script("/token", () => new Response("not json", { status: 200 }));
    const missing = await run(["login", "antigravity", "--timeout-seconds", "30"]);
    expect([missing.code, missing.stderr]).toEqual([1, "error: antigravity upstream HTTP 502: token response missing access_token\n"]);
    upstreams.script("/token", () => jsonResponse({ error: "backend" }, 500));
    const failing = await run(["login", "antigravity", "--timeout-seconds", "30"]);
    expect([failing.code, failing.stderr]).toEqual([1, 'error: antigravity upstream HTTP 500: {"error":"backend"}\n']);
  });
});

describe("stored accounts and state", () => {
  test("damaged accounts are 401s asking for a login; a non-string refresh token is ignored", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    const good = pool();
    const account = good.accounts[0]!;
    const withData = (data: Record<string, unknown>) => ({ ...good, accounts: [{ ...account, data }] });
    const tokens = account.data["tokens"] as Record<string, unknown>;
    for (const data of [
      { ...account.data, email: 5 },
      { ...account.data, tokens: [] },
      { ...account.data, tokens: { ...tokens, accessToken: 1 } },
      { ...account.data, projectIds: "p" },
      { ...account.data, projectIds: [1] },
    ]) {
      writePool(withData(data));
      const answer = await generate(s, hello);
      expect([answer.status, message(answer)]).toEqual([401, `antigravity: stored credential of ${account.id} is unreadable; run \`inference-router login antigravity\``]);
    }
    writePool(withData({ ...account.data, tokens: { ...tokens, refreshToken: 7 } }));
    expect((await generate(s, hello)).status).toBe(200);
    writePool({ accounts: [] });
    const none = await generate(s, hello);
    expect([none.status, message(none)]).toEqual([401, "antigravity: no active account; run `inference-router login antigravity`"]);
  });

  test("an account without a refresh token: a 401 is returned without a rotation, and an expired login cannot be renewed", async () => {
    home = await makeHome();
    upstreams.script("/token", googleToken({ refresh_token: undefined }));
    await login();
    const s = await serve();
    const logins = upstreams.find("/token").length;
    const unauthorized = () => jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401);
    upstreams.script(GENERATE, unauthorized);
    const rejected = await generate(s, hello);
    expect([rejected.status, (rejected.body["error"] as { status: string }).status]).toEqual([401, "UNAUTHENTICATED"]);
    expect(upstreams.find("/token").length - logins).toBe(0);
    upstreams.script("/v1internal:retrieveUserQuotaSummary", unauthorized);
    const quota = await run(["quota", "antigravity"]);
    expect([quota.code, upstreams.find("/token").length - logins]).toEqual([1, 0]);
    setTokens({ expiresAt: 0 });
    const expired = await generate(s, hello);
    expect([expired.status, message(expired)]).toEqual([401, "antigravity: access token expired and no refresh token is stored; run `inference-router login antigravity`"]);
  });

  test("signatures: a damaged store is ignored entry by entry; a failing write is logged and the answer still arrives", async () => {
    home = await makeHome();
    await login();
    let s = await serve();
    await generate(s, hello);
    const state = join(home.dir, "state", "antigravity");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "thought-signatures.json"), JSON.stringify({ kept: "S-KEPT", odd: 5 }));
    s = await restart();
    const call = (id: string) => ({ functionCall: { id, name: "f", args: {} } });
    const reply = (id: string) => ({ functionResponse: { id, name: "f", response: {} } });
    const fresh = await generate(s, {
      contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [call("kept"), call("odd")] }, { role: "user", parts: [reply("kept"), reply("odd")] }],
    });
    expect([fresh.status, fresh.headers.get("x-router-dropped")]).toEqual([200, "unsigned_function_call:odd"]);
    chmodSync(state, 0o500);
    upstreams.script(GENERATE, () => envelopeStream({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "new", name: "f", args: {} }, thoughtSignature: "S-NEW" }] }, finishReason: "STOP" }] }));
    const signed = await generate(s, hello);
    expect(signed.status).toBe(200);
    await until(() => routerLog().includes("WARN antigravity: signature persist failed"), "the persist warning");
    chmodSync(state, 0o700);
  });
});

describe("tool schemas and turn shapes", () => {
  test("array-valued schema keywords and type unions; calls without ids or args; a leading model turn; a '|' in the first user text", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    const parameters = { type: "object", properties: { x: { type: ["string", "null"], enum: ["a", "b"] } }, required: ["x"] };
    const body = {
      tools: [{ functionDeclarations: [{ name: "f", parameters }] }],
      contents: [
        { role: "model", parts: [{ text: "intro" }] },
        { role: "user", parts: [{ text: "a|b" }] },
        { role: "model", parts: [{ functionCall: { name: "f" }, thoughtSignature: "S" }] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] },
      ],
    };
    const first = await generate(s, body);
    expect(first.status).toBe(200);
    const sent = JSON.parse(upstreams.find(GENERATE).at(-1)!.body) as { request: { tools: { functionDeclarations: { parameters: unknown }[] }[] } };
    expect(sent.request.tools[0]!.functionDeclarations[0]!.parameters).toEqual({ type: "OBJECT", properties: { x: { type: ["string", "null"], enum: ["a", "b"] } }, required: ["x"] });
    expect((await generate(s, body)).status).toBe(200);
    const noUserText = await generate(s, { contents: [{ role: "model", parts: [{ functionCall: { id: "c", name: "f", args: {} }, thoughtSignature: "S" }] }, { role: "user", parts: [{ functionResponse: { id: "c", name: "f", response: {} } }] }] });
    expect(noUserText.status).toBe(200);
  });

  test("the signature store keeps the newest 2000 entries", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    const parts = Array.from({ length: 2001 }, (_, i) => ({ functionCall: { id: `c${i}`, name: "f", args: {} }, thoughtSignature: `S${i}` }));
    upstreams.script(GENERATE, () => envelopeStream({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] }));
    expect((await generate(s, hello)).status).toBe(200);
    const file = join(home.dir, "state", "antigravity", "thought-signatures.json");
    await until(() => existsSync(file) && Object.keys(JSON.parse(readFileSync(file, "utf8")) as object).length === 2000, "the stored signatures");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect([stored["c0"], stored["c1"], stored["c2000"]]).toEqual([undefined, "S1", "S2000"]);
  });
});

describe("refresh lock", () => {
  test("a held lock is waited for and the token rotated meanwhile is used; a forced rotation reuses a token rotated meanwhile", async () => {
    home = await makeHome();
    upstreams.script("/v1internal:fetchUserInfo", () => jsonResponse({ userSettings: { email: "first@example.com" } }));
    await login();
    upstreams.script("/v1internal:fetchUserInfo", () => jsonResponse({ userSettings: { email: "second@example.com" } }));
    upstreams.script("/token", googleToken({ expires_in: 60 }));
    await login();
    const session = await serve();
    expect((await generate(session, hello)).status).toBe(200);
    expect(pool().accounts.map((a) => [a.id, (a.data["tokens"] as { accessToken: string }).accessToken])).toEqual([
      ["first@example.com", "e2e-google-access"],
      ["second@example.com", "e2e-google-access"],
    ]);

    setTokens({ expiresAt: 0 });
    holdLock();
    const before = upstreams.find("/token").length;
    const waiting = generate(session, hello);
    await Bun.sleep(300);
    setTokens({ accessToken: "rotated-elsewhere", expiresAt: Date.now() + 3_600_000 });
    rmSync(LOCK());
    const waited = await waiting;
    expect([waited.status, lastBearer(), upstreams.find("/token").length - before]).toEqual([200, "Bearer rotated-elsewhere", 0]);

    const unauthorized = () => jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401);
    upstreams.script(GENERATE, unauthorized);
    holdLock();
    const calls = upstreams.find(GENERATE).length;
    const forced = generate(session, hello);
    await until(() => upstreams.find(GENERATE).length > calls, "the 401");
    await Bun.sleep(100);
    setTokens({ accessToken: "rotated-again" });
    rmSync(LOCK());
    expect([(await forced).status, lastBearer(), upstreams.find("/token").length - before]).toEqual([200, "Bearer rotated-again", 0]);
  });

  test("a stale lock is taken over, also when it cannot be removed at once; an unwritable lock directory is a 500", async () => {
    home = await makeHome();
    await login();
    const session = await serve();
    setTokens({ expiresAt: 0 });
    holdLock(120_000);
    expect((await generate(session, hello)).status).toBe(200);
    expect(existsSync(LOCK())).toBe(false);

    setTokens({ expiresAt: 0 });
    holdLock(120_000);
    chmodSync(join(home.dir, "locks"), 0o500);
    const blocked = generate(session, hello);
    await Bun.sleep(200);
    chmodSync(join(home.dir, "locks"), 0o700);
    expect((await blocked).status).toBe(200);

    setTokens({ expiresAt: 0 });
    chmodSync(join(home.dir, "locks"), 0o500);
    const refused = await generate(session, hello);
    chmodSync(join(home.dir, "locks"), 0o700);
    expect([refused.status, (refused.body["error"] as { status: string }).status]).toEqual([500, "INTERNAL"]);
    expect(routerLog()).toContain("EACCES");
  });

  test("a lock that cannot be released is left behind; hooks: a lock timeout is a 500, a lock that vanishes is not stale", async () => {
    home = await makeHome();
    await login();
    let session = await serve({ INFERENCE_ROUTER_TEST_LOCK_TIMEOUT_MS: "300" });
    // An expiring (still valid) token whose renewal fails with a 5xx is used as stored (H4): nothing is written, so the
    // only file the locks directory still needs is the release of the renewal lock, which the chmod makes fail.
    setTokens({ expiresAt: Date.now() + 60_000 });
    let release: () => void = () => undefined;
    const refreshing = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    upstreams.script("/token", async () => {
      entered = true;
      await refreshing;
      return jsonResponse({ error: "backend" }, 503);
    });
    const slow = generate(session, hello);
    await until(() => entered, "the refresh");
    chmodSync(join(home.dir, "locks"), 0o500);
    release();
    expect((await slow).status).toBe(200);
    chmodSync(join(home.dir, "locks"), 0o700);
    expect(existsSync(LOCK())).toBe(true);

    setTokens({ expiresAt: 0 });
    const timedOut = await generate(session, hello);
    expect([timedOut.status, (timedOut.body["error"] as { status: string }).status]).toEqual([500, "INTERNAL"]);
    expect(routerLog()).toContain(`could not acquire ${LOCK()} within 300 ms`);

    session = await restart({ INFERENCE_ROUTER_TEST_LOCK_STAT_VANISHES: "1" });
    const waiting = generate(session, hello);
    await Bun.sleep(300);
    rmSync(LOCK());
    expect((await waiting).status).toBe(200);
  });
});
