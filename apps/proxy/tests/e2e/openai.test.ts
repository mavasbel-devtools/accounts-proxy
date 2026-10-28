// The openai provider (Sign in with ChatGPT, plan usage), black-box through the real proxy process (live validation
// L4, docs/plans/2026-10-13-01-42-live-validation-plan.md). Replays: the live Responses streams captured on 2026-10-13
// (tests/fixtures/captures/p0-live/l1); the model list is the reference catalog's (recon gap P4), the fake browser approving a new registration (issued client
// id in the callback, S2/S9), token answers with the live shape (fields of the token reference; scopes as granted
// live), and ID tokens with the live claim names signed by the replay's own key (openai-signing.ts).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import OpenAI from "openai";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, type Daemon, type Home, readPool, writePool, proxyLogOf } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { claims, GRANTED_SCOPES, idToken, jwks, signingKey } from "@accounts-proxy/test-support/e2e/openai-signing.ts";
import { jsonResponse, ReplayUpstreams, spec, stalledStream, type Recorded, type Responder } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(120_000);
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

const OPENAI = "providers:\n  openai: {enabled: true, acknowledgeTermsRisk: true}\n";
const TOKEN = "/api/accounts/oauth/token";
const JWKS = "/.well-known/jwks.json";
const REGISTER = { ACCOUNTS_PROXY_E2E_BROWSER_MODE: "approve-registration" };
const run = (argv: string[], env: Record<string, string> = {}) => runProxy(home!, argv, { ...upstreams.seamEnv(), ...env });
const login = (env: Record<string, string> = REGISTER, ...flags: string[]) => run(["login", "openai", "--timeout-seconds", "30", ...flags], env);

/** The authorization URL the fake browser opened last. */
const opened = () => new URL(readFileSync(home!.browserLog, "utf8").split("\n").filter((l) => l.startsWith("http")).at(-1)!);
const form = (request: Recorded) => new URLSearchParams(request.body);
/** A token answer of the live shape; `token` builds the ID token from the request's client id and this attempt's nonce. */
const granted =
  (over: Record<string, unknown> = {}, token: (clientId: string, nonce: string) => string | undefined = (c, n) => idToken(claims(c, n))): Responder =>
  (_body, request) => {
    const id = token(form(request).get("client_id")!, opened().searchParams.get("nonce")!);
    return jsonResponse({ access_token: "e2e-openai-access", refresh_token: "e2e-openai-refresh", ...(id !== undefined ? { id_token: id } : {}), expires_in: 3600, scope: GRANTED_SCOPES, token_type: "Bearer", ...over });
  };
const accounts = () => readPool(home!, "openai")! as { activeId: string; accounts: { id: string; label: string; needsLogin?: string; data: Record<string, unknown> }[] };
function storeAccount(data: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writePool(home!, "openai", { accounts: [{ provider: "openai", id: "oaiapp_e2e", label: "e2e@example.com", data, ...extra }], activeId: "oaiapp_e2e" });
}
/** gpt-5.6-luna in the list, its name and limits from the reference catalog (rule M1). */
const MODELS_LINE = "openai/gpt-5.6-luna  GPT-5.6 Luna  context 1050000 / output 128000\n";
const ACCOUNT = { accessToken: "e2e-openai-access", refreshToken: "e2e-openai-refresh", expiresAt: Date.now() + 3_600_000, scopes: GRANTED_SCOPES, clientId: "oaiapp_e2e", subject: "e2e-subject", idToken: "x.y.z", email: "e2e@example.com" };

describe("sign-in (rules S1–S16)", () => {
  test("a new registration: the authorize URL, the exchange, the verified ID token; the account, its models and a re-login", async () => {
    home = await makeHome(OPENAI);
    upstreams.script(TOKEN, granted());
    const first = await login();
    expect([first.code, first.stderr, first.stdout]).toEqual([0, "", expect.stringContaining("signed in to openai as e2e@example.com (active account)\n")]);
    const url = opened();
    expect([url.pathname, url.searchParams.get("client_id"), url.searchParams.get("agent_name_hint"), url.searchParams.get("redirect_uri"), url.searchParams.get("code_challenge_method")]).toEqual([
      "/api/accounts/authorize",
      "dynamic_agent_client",
      "accounts-proxy",
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/),
      "S256",
    ]);
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    const exchange = form(upstreams.find(TOKEN)[0]!);
    expect([exchange.get("grant_type"), exchange.get("client_id"), exchange.get("code"), exchange.get("resource")]).toEqual(["authorization_code", "oaiapp_e2e", "e2e-code", "https://api.openai.com/v1"]);
    expect(upstreams.find(JWKS)).toHaveLength(1);
    expect(accounts().accounts.map((a) => [a.id, a.label, a.data["subject"], a.data["scopes"]])).toEqual([["oaiapp_e2e", "e2e@example.com", "e2e-subject", GRANTED_SCOPES]]);
    expect((await run(["account", "list", "openai"])).stdout).toBe("* oaiapp_e2e  (e2e@example.com)\n");

    // Recon gap P4: opencode's list, the reference's openai models with an allowed id; no model-list call to OpenAI.
    const models = await run(["models", "openai"]);
    expect(models.stdout.split("\n")[0]).toBe("# openai: 8 models (live catalog)");
    expect(models.stdout).toContain(MODELS_LINE);
    expect(upstreams.find("/v1/models")).toHaveLength(0);

    // A re-login re-authorizes the saved registration with its issued client id (the callback carries none) and the
    // stored host id; the same subject is accepted.
    upstreams.script(TOKEN, granted());
    const again = await login({});
    expect([again.code, again.stderr]).toEqual([0, ""]);
    expect([opened().searchParams.get("client_id"), opened().searchParams.get("agent_name_hint"), opened().searchParams.get("ext_agent_host_id")]).toEqual(["oaiapp_e2e", null, url.searchParams.get("ext_agent_host_id")]);
    // A re-login returning another account, or another client, is refused; --new registers another account.
    upstreams.script(TOKEN, granted({}, (c, n) => idToken(claims(c, n, "other-subject"))));
    expect(await login({})).toMatchObject({ code: 1, stderr: expect.stringContaining("the sign-in returned a different ChatGPT account than this registration; use `login openai --new` to add it") });
    expect(await login({ ...REGISTER, ACCOUNTS_PROXY_E2E_ISSUED_CLIENT: "oaiapp_other" })).toMatchObject({ code: 1, stderr: expect.stringContaining("ChatGPT returned a different client than this registration") });
    upstreams.script(TOKEN, granted({}, (c, n) => idToken(claims(c, n, "second-subject", null))));
    const second = await login({ ...REGISTER, ACCOUNTS_PROXY_E2E_ISSUED_CLIENT: "oaiapp_second" }, "--new");
    expect([second.code, second.stdout]).toEqual([0, expect.stringContaining("signed in to openai as second-subject (active account)\n")]);
    expect(accounts().accounts.map((a) => a.id)).toEqual(["oaiapp_e2e", "oaiapp_second"]);
  });

  test("refused sign-ins: no issued client, the grant refused or malformed, no plan usage, no ID token", async () => {
    home = await makeHome(OPENAI);
    expect(await login({})).toMatchObject({ code: 1, stderr: expect.stringContaining("ChatGPT sign-in did not return an issued client id (registration incomplete)") });
    for (const [answer, message] of [
      [() => jsonResponse({ error: "invalid_grant" }, 400), "token endpoint rejected the grant (HTTP 400 invalid_grant)"],
      [() => jsonResponse("{}", 401), "token endpoint rejected the grant (HTTP 401)"],
      [() => new Response("busy", { status: 503 }), "openai upstream HTTP 503: busy"],
      [() => new Response("<html>", { status: 200 }), "token endpoint returned non-JSON: <html>"],
      [() => jsonResponse({ access_token: "a" }), "token endpoint response lacks access_token/refresh_token"],
      [granted({ scope: "openid email" }), "the sign-in did not grant ChatGPT plan usage (chatgpt.tokens.use.direct)"],
      [granted({ scope: 1, expires_in: "soon" }), "the sign-in did not grant ChatGPT plan usage"],
      [granted({}, () => undefined), "ChatGPT sign-in did not return an ID token"],
    ] as const) {
      upstreams.script(TOKEN, answer);
      const result = await login();
      expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
    }
    expect(readPool(home, "openai")).toBeUndefined();
  });

  test("ID tokens that do not verify (S12): form, algorithm, key, signature and each claim", async () => {
    home = await makeHome(OPENAI);
    const broken = (token: (clientId: string, nonce: string) => string) => granted({}, token);
    const signedOther = (c: string, n: string) => {
      const [head, body] = idToken(claims(c, n)).split(".");
      return `${head}.${body}.${idToken(claims(c, "x")).split(".")[2]}`;
    };
    const fetchesBefore = upstreams.find(JWKS).length;
    for (const [token, message] of [
      [() => "a.b", "not a compact JWS (three dot-separated parts)"],
      [() => "!!.e30.c2ln", "the header is not a base64url JSON object"],
      [() => "AAAAA.e30.c2ln", "the header is not a base64url JSON object"],
      [() => `${Buffer.from("not json").toString("base64url")}.e30.c2ln`, "the header is not a base64url JSON object"],
      [(c: string, n: string) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from("[]").toString("base64url")}.${idToken(claims(c, n)).split(".")[2]}`, "the payload is not a base64url JSON object"],
      [(c: string, n: string) => `${idToken(claims(c, n)).split(".").slice(0, 2).join(".")}.`, "the signature is not base64url"],
      [(c: string, n: string) => idToken(claims(c, n), { alg: "HS256" }), 'algorithm "HS256" is not RS256'],
      [(c: string, n: string) => idToken(claims(c, n), { kid: "rotated" }), "no RSA key rotated in the published key set"],
      [signedOther, "the signature does not verify"],
      [(c: string, n: string) => idToken({ ...claims(c, n), iss: "https://evil.example" }), 'issuer "https://evil.example" is not https://auth.openai.com'],
      [(c: string, n: string) => idToken({ ...claims(c, n), aud: "someone-else" }), "the audience is not this client"],
      [(c: string, n: string) => idToken({ ...claims(c, n), exp: 1 }), "expired or without exp"],
      [(c: string) => idToken(claims(c, "another-attempt")), "the nonce does not match this sign-in attempt"],
      [(c: string, n: string) => idToken({ ...claims(c, n), sub: " " }), "the subject is missing"],
    ] as const) {
      upstreams.script(TOKEN, broken(token as (c: string, n: string) => string));
      const result = await login();
      expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(`ChatGPT sign-in returned an invalid ID token: ${message}`)]);
    }
    // The seven malformed tokens fail before any key is read; the unknown kid fetches the set twice (rotation retry).
    expect(upstreams.find(JWKS).length - fetchesBefore).toBe(8);
  });

  test("the key set (S12): a single key without kid, a token without kid among several keys, refused or malformed sets", async () => {
    home = await makeHome(OPENAI);
    const noKid = (c: string, n: string) => idToken(claims(c, n), { kid: undefined });
    upstreams.script(JWKS, () => jsonResponse({ keys: [{ ...signingKey(), kid: undefined, use: undefined }, { kty: "EC" }, 1] }));
    upstreams.script(TOKEN, granted({}, noKid));
    expect((await login()).code).toBe(0);
    // Each answer serves every fetch of one login (the second fetch is the rotation retry of a key not found).
    for (const [keys, fetches, message] of [
      [() => jsonResponse(jwks([{ ...signingKey(), kid: "second" }])), 2, "no RSA key (no kid) in the published key set"],
      [() => new Response("down", { status: 500 }), 1, "openai upstream HTTP 500: JWKS: down"],
      [() => new Response("<html>"), 1, "JWKS is not a key set: <html>"],
      [() => jsonResponse({ keys: {} }), 1, "JWKS is not a key set"],
    ] as const) {
      for (let i = 0; i < fetches; i++) upstreams.script(JWKS, keys);
      upstreams.script(TOKEN, granted({}, noKid));
      const result = await login(REGISTER, "--new");
      expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
    }
  });

  test("the host id: a stored id of an accepted form is kept, any other value is replaced", async () => {
    home = await makeHome(OPENAI);
    mkdirSync(join(home.dir, "state", "openai"), { recursive: true, mode: 0o700 });
    for (const [stored, expected] of [
      ["did:key:z6MkE2E", "did:key:z6MkE2E"],
      ["not-a-host-id", /^urn:uuid:[0-9a-f-]{36}$/],
    ] as const) {
      writeFileSync(join(home.dir, "state", "openai", "host-id.json"), JSON.stringify(stored), { mode: 0o600 });
      upstreams.script(TOKEN, granted());
      expect((await login(REGISTER, "--new")).code).toBe(0);
      expect(opened().searchParams.get("ext_agent_host_id")).toEqual(typeof expected === "string" ? expected : expect.stringMatching(expected));
    }
  });
});

describe("the native Responses cell (rules I1–I6, E1–E3, O7–O9)", () => {
  const client = (s: { url: string; token: string }, headers: Record<string, string> = {}) => new OpenAI({ apiKey: s.token, baseURL: `${s.url}/openai/v1`, maxRetries: 0, defaultHeaders: headers });
  async function serve(account: Record<string, unknown> = ACCOUNT): Promise<{ url: string; token: string }> {
    home = await makeHome(OPENAI);
    storeAccount(account);
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    return { url: daemon.url, token };
  }
  const post = (s: { url: string; token: string }, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(`${s.url}/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body), ...(signal !== undefined ? { signal } : {}) });
  const sent = () => upstreams.find("/v1/responses").at(-1)!;

  test("the official SDK: streamed and not, a tool loop; the terminal response carries the streamed items (I6)", async () => {
    const s = await serve();
    const stream = client(s).responses.stream({ model: "openai/gpt-5.6-luna", input: "Reply with the single word OK." });
    const deltas: string[] = [];
    stream.on("response.output_text.delta", (e) => void deltas.push(e.delta));
    const final = await stream.finalResponse();
    expect([deltas.join(""), final.output_text, final.status]).toEqual(["OK", "OK", "completed"]);
    const request = sent();
    // Recon gaps P1–P3: the body zstd-compressed (the replay records it decoded), the client's own User-Agent, no
    // explicit accept (the runtime's default).
    expect(JSON.parse(request.body)).toEqual({ model: "gpt-5.6-luna", input: [{ role: "user", content: "Reply with the single word OK." }], stream: true, store: false });
    expect([request.headers["authorization"], request.headers["content-encoding"], request.headers["user-agent"], request.headers["accept"]]).toEqual(["Bearer e2e-openai-access", "zstd", "OpenAI/JS 7.32.0", "*/*"]);
    expect(request.headers["session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect([request.headers["thread-id"], request.headers["x-client-request-id"]]).toEqual([request.headers["session-id"], request.headers["session-id"]]);

    const { data, response } = await client(s).responses.create({ model: "openai/gpt-5.6-luna", input: "Reply with the single word OK." }).withResponse();
    // I7: the captured stream has no content-type and names the request in x-oai-request-id.
    const REQUEST_ID = "req_06c5df075a924d639a6e38a569ce2159";
    expect([data.output_text, response.headers.get("content-type"), response.headers.get("x-oai-request-id")]).toEqual(["OK", "application/json", REQUEST_ID]);
    const raw = await fetch(`${s.url}/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "Reply with the single word OK.", stream: true }) });
    expect([raw.status, raw.headers.get("content-type"), raw.headers.get("x-oai-request-id")]).toEqual([200, "text/event-stream", REQUEST_ID]);
    expect(await raw.text()).toContain("event: response.completed");

    const tool = { type: "function" as const, name: "get_time", description: "time", parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] }, strict: false };
    const first = await client(s, { "session-id": "ses_client", "thread-id": "thr_client" }).responses.create({ model: "openai/gpt-5.6-luna", input: "time in Tokyo?", tools: [tool] });
    const call = first.output.find((i) => i.type === "function_call")!;
    expect(call.type === "function_call" && call.name).toBe("get_time");
    expect([sent().headers["session-id"], sent().headers["thread-id"], sent().headers["x-client-request-id"]]).toEqual(["ses_client", "thr_client", "thr_client"]);
    const second = await client(s).responses.create({ model: "openai/gpt-5.6-luna", tools: [tool], input: [{ role: "user", content: "time in Tokyo?" }, { type: "function_call", call_id: call.type === "function_call" ? call.call_id : "", name: "get_time", arguments: "{}" }, { type: "function_call_output", call_id: call.type === "function_call" ? call.call_id : "", output: "16:05" }] });
    expect(second.output_text).toContain("16:05");
  });

  test("recon gaps P1–P3: opencode's own recorded request goes upstream with its headers in name order and a zstd body; a client without a User-Agent gets the proxy's", async () => {
    const s = await serve();
    // opencode v2.1.1's tool-result request (recon run opencode/2026-10-24-07-22-48 seq 5), as it reaches the proxy.
    const recorded = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "tests", "fixtures", "captures", "recon-parity", "opencode-2.1.1", "2026-10-24-07-22-48-workflow", "captures", "005-request.json"), "utf8")) as { headers: [string, string][]; body: string };
    const hop = new Set(["authorization", "content-encoding", "content-length", "connection", "accept", "host", "accept-encoding"]);
    const own = recorded.headers.filter(([name]) => !hop.has(name.toLowerCase()));
    const body = { ...(JSON.parse(recorded.body) as Record<string, unknown>), model: "openai/gpt-5.6-luna" };
    const answer = await post(s, body, Object.fromEntries(own));
    expect(answer.status).toBe(200);
    await answer.text();
    const upstream = sent();
    expect([upstream.headers["content-encoding"], upstream.headers["user-agent"], upstream.headers["x-opencode-client"], upstream.headers["x-session-affinity"]]).toEqual(["zstd", "opencode/latest/2.1.1/cli", "cli", recorded.headers.find(([n]) => n === "x-session-affinity")![1]]);
    expect(JSON.parse(upstream.body)).toMatchObject({ model: "gpt-5.6-luna", store: false, stream: true });

    const target = new URL(`${s.url}/openai/v1/responses`);
    const bare = await new Promise<number>((resolve, reject) => {
      const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "openai/gpt-5.6-luna", input: "Reply with the single word OK." }));
    });
    expect([bare, sent().headers["user-agent"]]).toEqual([200, "accounts-proxy/0.1.0"]);
  });

  test("documented limits (I3–I4, O7): 400 unsupported_feature, or dropped and reported with x-proxy-lossy", async () => {
    const s = await serve();
    for (const [body, feature] of [
      [{ input: "x", max_output_tokens: 64 }, "max_output_tokens"],
      [{ input: "x", store: true }, "store"],
      [{ input: [{ role: "system", content: "s" }, { role: "user", content: "x" }] }, "input.system_message"],
      [{ input: [{ type: "message", role: "system", content: "s" }] }, "input.system_message"],
      [{ input: "x", tools: [{ type: "image_generation" }, { type: "function", name: "f" }] }, "tools.image_generation"],
      [{ input: "x", tool_choice: { type: "file_search" } }, "tool_choice.file_search"],
    ] as const) {
      const strict = await post(s, { model: "openai/gpt-5.6-luna", ...body });
      expect([strict.status, ((await strict.json()) as { error: { message: string } }).error.message]).toEqual([400, `openai (ChatGPT plan usage) cannot carry: ${feature}`]);
    }
    const lossy = await post(s, { model: "openai/gpt-5.6-luna", input: [{ role: "system", content: "s" }, { role: "user", content: "x" }], temperature: 0, store: true, metadata: null, tools: [{ type: "mcp" }, { type: "function", name: "f" }], tool_choice: { type: "mcp" } }, { "x-proxy-lossy": "1" });
    expect([lossy.status, lossy.headers.get("x-proxy-dropped")]).toEqual([200, "temperature,store,input.system_message,tools.mcp,tool_choice.mcp"]);
    expect(JSON.parse(sent().body)).toEqual({ model: "gpt-5.6-luna", input: [{ role: "user", content: "x" }], tools: [{ type: "function", name: "f" }], stream: true, store: false });
    for (const [body, message] of [
      [{ model: "openai/gpt-5.6-luna", input: "x", stream: "yes" }, "stream must be a boolean"],
      [{ model: "openai/gpt-5.6-luna", input: 1 }, "input must be a string or an array of input items"],
    ] as const) {
      const invalid = await post(s, body);
      expect([invalid.status, ((await invalid.json()) as { error: { message: string } }).error.message]).toEqual([400, message]);
    }
    const otherPath = await fetch(`${s.url}/openai/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [] }) });
    expect([otherPath.status, ((await otherPath.json()) as { error: { code: string } }).error.code]).toEqual([400, "unsupported_feature"]);
  });

  test("answers after the stream opened (E2–E3) and upstream errors before it (E1)", async () => {
    const s = await serve();
    const frame = (e: Record<string, unknown>) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`;
    const sse = (...events: Record<string, unknown>[]) => () => new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
    upstreams.script(
      "/v1/responses",
      sse({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "plan limit" } } }),
      sse({ type: "error", code: "server_error", message: "boom", param: null }),
      sse({ type: "response.created", response: { id: "r" } }),
      sse({ type: "response.incomplete", response: { id: "r", status: "incomplete", output: [] } }),
      () => jsonResponse({ detail: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." }, 400),
      sse({ type: "response.created", response: { id: "r" } }),
      sse({ type: "response.failed" }),
      // I6 with two items out of order, a non-JSON frame among them (aggregated).
      () => new Response(`data: [DONE]\n\ndata: 1\n\n${frame({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "m2" } })}${frame({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r1" } })}${frame({ type: "response.completed", response: { id: "r", output: [] } })}`, { headers: { "content-type": "text/event-stream" } }),
      // I6 for a streaming client: frames that are not events pass, `data:` without a space, a last frame without its blank line.
      () => new Response(`data: [DONE]\n\ndata: 1\n\ndata:${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1" } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", output: [] } })}`, { headers: { "content-type": "text/event-stream" } }),
      // A terminal response that has its own output is not touched.
      sse({ type: "response.completed", response: { id: "r", output: [{ type: "message", id: "own" }] } }),
    );
    const limited = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect([limited.status, await limited.json()]).toEqual([429, { error: { message: "plan limit", type: "response_failed", param: null, code: "subscription_sharing_usage_limit_exceeded" } }]);
    const failed = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect([failed.status, ((await failed.json()) as { error: { message: string } }).error.message]).toEqual([502, "boom"]);
    const unterminated = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect([unterminated.status, ((await unterminated.json()) as { error: { message: string } }).error.message]).toEqual([502, "upstream stream ended without response.completed"]);
    const incomplete = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect([incomplete.status, ((await incomplete.json()) as { status: string }).status]).toEqual([200, "incomplete"]);
    const refused = await post(s, { model: "openai/no-such-model", input: "x", stream: true });
    expect([refused.status, await refused.json()]).toEqual([400, { detail: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." }]);
    const open = await post(s, { model: "openai/gpt-5.6-luna", input: "x", stream: true });
    expect([open.status, await open.text()]).toEqual([200, `event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n`]);
    const bare = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect([bare.status, await bare.json()]).toEqual([502, { error: { message: "the response failed", type: "response_failed", param: null, code: null } }]);
    const ordered = await post(s, { model: "openai/gpt-5.6-luna", input: "x" });
    expect(((await ordered.json()) as { output: unknown[] }).output).toEqual([{ type: "reasoning", id: "r1" }, { type: "message", id: "m2" }]);
    const repaired = await (await post(s, { model: "openai/gpt-5.6-luna", input: "x", stream: true })).text();
    expect(repaired).toBe(`data: [DONE]\n\ndata: 1\n\ndata:${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1" } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", output: [{ type: "message", id: "m1" }] } })}`);
    const own = await (await post(s, { model: "openai/gpt-5.6-luna", input: "x", stream: true })).text();
    expect(own).toContain('"output":[{"type":"message","id":"own"}]');
    // A frame split across upstream chunks reaches the client whole.
    const whole = frame({ type: "response.created", response: { id: "split" } });
    upstreams.script("/v1/responses", () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(whole.slice(0, 20)));
        await Bun.sleep(100);
        controller.enqueue(new TextEncoder().encode(whole.slice(20)));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect(await (await post(s, { model: "openai/gpt-5.6-luna", input: "x", stream: true })).text()).toBe(whole);
    // A client that leaves before the end: the upstream is cancelled and the log says so.
    let cancelled = false;
    upstreams.script("/v1/responses", () => stalledStream(frame({ type: "response.created", response: { id: "left" } }), () => void (cancelled = true)));
    const leaving = new AbortController();
    const left = await post(s, { model: "openai/gpt-5.6-luna", input: "x", stream: true }, {}, leaving.signal);
    await left.body!.getReader().read();
    leaving.abort();
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(50);
    expect(cancelled).toBe(true);
    await daemon!.stop();
    daemon = undefined;
    const log = proxyLogOf(home!);
    expect(log).toContain("INFO openai: stream end model=gpt-5.6-luna terminal=none");
    expect(log).toContain("INFO openai: stream closed by the client model=gpt-5.6-luna terminal=none");
  });
});

describe("session and catalog (T1–T5, M1–M2)", () => {
  test("an expired token is renewed once (the refresh token rotates); a refused renewal marks the account for a new login", async () => {
    home = await makeHome(OPENAI);
    // The model list needs no account (recon gap P4), so a Responses request is what renews.
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const ask = () => fetch(`${daemon!.url}/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "x" }) });
    storeAccount({ ...ACCOUNT, expiresAt: Date.now() - 1000 });
    upstreams.script(TOKEN, () => jsonResponse({ access_token: "e2e-openai-access-2", refresh_token: "e2e-openai-refresh-2", expires_in: 3600, scope: GRANTED_SCOPES }));
    expect((await ask()).status).toBe(200);
    const refresh = form(upstreams.find(TOKEN).at(-1)!);
    expect([refresh.get("grant_type"), refresh.get("client_id"), refresh.get("refresh_token"), refresh.get("resource")]).toEqual(["refresh_token", "oaiapp_e2e", "e2e-openai-refresh", "https://api.openai.com/v1"]);
    expect([accounts().accounts[0]!.data["accessToken"], accounts().accounts[0]!.data["refreshToken"], accounts().accounts[0]!.data["scopes"]]).toEqual(["e2e-openai-access-2", "e2e-openai-refresh-2", GRANTED_SCOPES]);

    storeAccount({ ...ACCOUNT, expiresAt: Date.now() - 1000 });
    upstreams.script(TOKEN, () => jsonResponse({ access_token: "e2e-openai-access-3", refresh_token: "e2e-openai-refresh-3" }));
    expect((await ask()).status).toBe(200);
    expect([accounts().accounts[0]!.data["accessToken"], accounts().accounts[0]!.data["scopes"]]).toEqual(["e2e-openai-access-3", GRANTED_SCOPES]);

    storeAccount({ ...ACCOUNT, expiresAt: Date.now() - 1000 });
    upstreams.script(TOKEN, () => jsonResponse({ error: "invalid_grant" }, 400));
    const refused = await ask();
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([401, "provider_auth_required"]);
    expect(accounts().accounts[0]!.needsLogin).toContain("invalid_grant");
    expect((await run(["account", "list", "openai"])).stdout).toContain("[needs login");
  });

  test("the model list (M2, recon gap P4): the reference's openai models with an allowed id, with or without an account; never a model-list call", async () => {
    home = await makeHome(OPENAI);
    expect((await run(["models", "openai"])).stdout.split("\n")[0]).toBe("# openai: 8 models (live catalog)");
    storeAccount(ACCOUNT);
    const listed = await run(["models", "openai"]);
    expect(listed.stdout.split("\n")[0]).toBe("# openai: 8 models (stored copy of the live catalog)");
    expect(listed.stdout).toContain(MODELS_LINE);
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const served = await fetch(`${daemon.url}/openai/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(served.headers.get("x-proxy-models-source")).toBe("openai=cache");
    expect(upstreams.find("/v1/models")).toHaveLength(0);
    // An account without an e-mail is used as it is.
    const { email: _email, ...withoutEmail } = ACCOUNT;
    storeAccount(withoutEmail);
    const used = await fetch(`${daemon.url}/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "x" }) });
    expect([used.status, upstreams.find("/v1/responses").at(-1)!.headers["authorization"]]).toEqual([200, "Bearer e2e-openai-access"]);
    await used.text();
    // Stored accounts of another shape are unreadable: a request needs a new login.
    for (const data of [{ accessToken: 1 }, { ...ACCOUNT, clientId: 1 }]) {
      storeAccount(data);
      const refused = await fetch(`${daemon.url}/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "x" }) });
      expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([401, "provider_auth_required"]);
    }
  });

  test("a reference catalog without an openai provider lists no openai model (the list is opencode's, never OpenAI's)", async () => {
    home = await makeHome(OPENAI);
    const { openai: _openai, ...others } = JSON.parse(spec("models-opencode-reference.json")) as Record<string, unknown>;
    upstreams.script("/api.json", () => jsonResponse(others));
    expect((await run(["models", "openai"])).stdout).toBe("# openai: 0 models (live catalog)\n");
    expect(upstreams.find("/v1/models")).toHaveLength(0);
  });;
});
