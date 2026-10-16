// The API-key gateways (plan P4.6), black-box through the real proxy process: catalogs from the vendors' committed
// public lists, the OpenRouter PKCE login (browser and headless) answered with OpenRouter's documented examples, key
// logins at the hidden prompt, native cells per model format (the bare model id, the key in each endpoint's header,
// the answer unchanged), translated cells refused, and the captured OpenCode gateway refusal passed through.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { captured, openRouterExample, ReplayUpstreams, spec } from "@accounts-proxy/test-support/e2e/upstreams.ts";

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
  if (home !== undefined && existsSync(join(home.dir, "state", "opencode"))) chmodSync(join(home.dir, "state", "opencode"), 0o700);
  if (home !== undefined) removeTemporary(home.dir);
  home = undefined;
});

const GATEWAYS = "providers:\n  openrouter: {enabled: true}\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n  cheaper-inference: {enabled: true}\n";
const run = (argv: string[], input?: string, env: Record<string, string> = {}) => runProxy(home!, argv, { ...upstreams.seamEnv(), ...env }, input === undefined ? undefined : async () => input);
async function serve(): Promise<{ url: string; token: string }> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, upstreams.seamEnv());
  return { url: daemon.url, token };
}
const pool = (provider: string) => JSON.parse(readFileSync(join(home!.dir, `accounts-${provider}.json`), "utf8")) as { activeId: string; accounts: { id: string; data: { apiKey: string } }[] };
/** The proxy's own account file, written directly (a key the vendor's check could not confirm without a capture). */
function writeKeyAccount(provider: string, data: Record<string, unknown>): void {
  writeFileSync(join(home!.dir, `accounts-${provider}.json`), JSON.stringify({ accounts: [{ provider, id: "key-e2e", label: "key-e2e", data }], activeId: "key-e2e" }), { mode: 0o600 });
}
/** The captured OpenCode gateway refusal (probe z0), as a scripted answer. */
const zenRefusal = () => {
  const answer = captured("gateways/z0-opencode-keyless-none.json");
  return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType } });
};
const documented = (path: string, method: "get" | "post", status: string) => () => Response.json(openRouterExample(path, method, status, "application/json"), { status: Number(status) });
const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("gateway catalogs (rule G5, live lists from the committed vendor lists)", () => {
  test("models: every gateway's live list; the model lists of the three dialects carry them with their formats", async () => {
    home = await makeHome(GATEWAYS);
    const listed = await run(["models"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n").filter((l) => l.startsWith("# "))).toEqual([
      "# openrouter: 459 models (live catalog)",
      "# opencode: 84 models (live catalog)",
      "# opencode-go: 38 models (live catalog)",
      "# cheaper-inference: 91 models (live catalog)",
    ]);
    // The reference catalog is read once (rule M4): the OpenCode formats and the details share it.
    expect(upstreams.find("/api.json")).toHaveLength(1);
    const s = await serve();
    const gemini = (await (await fetch(`${s.url}/gemini/v1beta/models`, { headers: { "x-goog-api-key": s.token } })).json()) as { models: { name: string; supportedGenerationMethods: string[] }[] };
    const methods = (name: string) => gemini.models.find((m) => m.name === `models/${name}`)!.supportedGenerationMethods;
    expect([methods("opencode/gemini-3.6-flash"), methods("opencode/big-pickle"), methods("openrouter/meta/muse-wonder")]).toEqual([["generateContent", "streamGenerateContent"], [], []]);
    const openai = await fetch(`${s.url}/openai/v1/models`, { headers: { authorization: `Bearer ${s.token}` } });
    // The daemon reads the copies the CLI stored a moment ago (fresh for 24 h).
    expect(openai.headers.get("x-proxy-models-source")).toBe("openrouter=cache,opencode=cache,opencode-go=cache,cheaper-inference=cache");
  });
});

describe("openrouter (rules R1–R11, OpenRouter's documented examples)", () => {
  test("browser PKCE login, quota, and the three native formats; count_tokens and Gemini are refused", async () => {
    home = await makeHome("providers:\n  openrouter: {enabled: true}\n");
    const login = await run(["login", "openrouter", "--timeout-seconds", "30"]);
    expect([login.code, login.stderr]).toEqual([0, ""]);
    expect(login.stdout).toContain("signed in to openrouter as user_2yOPcMpKoQhcd4bVgSMlELRaIah (active account)");
    const opened = new URL(readFileSync(home.browserLog, "utf8").split("\n")[0]!);
    expect([opened.pathname, opened.searchParams.get("code_challenge_method"), opened.searchParams.get("callback_url")]).toEqual(["/auth", "S256", expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/)]);
    const exchange = JSON.parse(upstreams.find("/api/v1/auth/keys")[0]!.body) as Record<string, string>;
    expect([Object.keys(exchange).sort(), exchange["code"], exchange["code_challenge_method"]]).toEqual([["code", "code_challenge_method", "code_verifier"], "e2e-code", "S256"]);
    expect(pool("openrouter").accounts[0]!.data.apiKey).toBe("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");

    const quota = await run(["quota", "openrouter"]);
    expect([quota.code, quota.stdout.split("\n")[0]]).toEqual([0, expect.stringMatching(/^OpenRouter key /)]);
    expect(upstreams.find("/api/v1/key")[0]!.headers["authorization"]).toBe("Bearer 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");

    const s = await serve();
    const auth = { authorization: `Bearer ${s.token}` };
    const chat = await post(`${s.url}/openai/v1/chat/completions`, auth, { model: "openrouter/openai/gpt-oss-20b:free", messages: [{ role: "user", content: "hi" }] });
    expect([chat.status, chat.headers.get("x-generation-id")]).toEqual([200, "gen-e2e"]);
    expect(((await chat.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("The capital of France is Paris.");
    const sent = upstreams.find("/api/v1/chat/completions")[0]!;
    expect([JSON.parse(sent.body).model, sent.headers["authorization"]]).toEqual(["openai/gpt-oss-20b:free", "Bearer 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"]);
    const stream = await post(`${s.url}/openai/v1/responses`, auth, { model: "openrouter/openai/gpt-oss-20b:free", input: "hi", stream: true });
    expect([stream.status, stream.headers.get("content-type"), await stream.text()]).toEqual([200, "text/event-stream", expect.stringContaining('"type":"response.output_text.delta"')]);
    const messages = await post(`${s.url}/anthropic/v1/messages`, { "x-api-key": s.token, "anthropic-version": "2023-06-01" }, { model: "openrouter/anthropic/claude-haiku-4.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect([messages.status, ((await messages.json()) as { id: string }).id]).toEqual([200, "msg_abc123"]);
    expect(upstreams.find("/api/v1/messages")[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    const count = await post(`${s.url}/anthropic/v1/messages/count_tokens`, { "x-api-key": s.token }, { model: "openrouter/a/b", messages: [] });
    expect([count.status, ((await count.json()) as { error: { message: string } }).error.message]).toEqual([400, "openrouter cannot carry: count_tokens"]);
    const translated = await post(`${s.url}/gemini/v1beta/models/openrouter%2Fa%2Fb:generateContent`, { "x-goog-api-key": s.token }, { contents: [] });
    expect([translated.status, ((await translated.json()) as { error: { message: string } }).error.message]).toEqual([400, "openrouter/a/b (it accepts openai-chat, openai-responses, anthropic-messages; the proxy does not translate between formats) cannot carry: gemini_format"]);
  });

  test("headless login (--manual): no callback, the pasted code is exchanged", async () => {
    home = await makeHome("providers:\n  openrouter: {enabled: true}\n");
    const login = await run(["login", "openrouter", "--manual"], "pasted-code\n");
    expect(login.code).toBe(0);
    const url = new URL(login.stdout.split("\n").find((l) => l.startsWith("http://127.0.0.1"))!);
    expect([url.searchParams.has("callback_url"), url.searchParams.has("state"), url.searchParams.get("key_label")]).toEqual([false, false, "accounts-proxy"]);
    expect((JSON.parse(upstreams.find("/api/v1/auth/keys").at(-1)!.body) as { code: string }).code).toBe("pasted-code");
    expect(await run(["login", "openrouter", "--manual"])).toMatchObject({ code: 1, stderr: "error: standard input ended before a line was entered\n" });
  });
});

describe("opencode and opencode-go after the Console migration (amendment A, rules Z12–Z23)", () => {
  test("device login (K1, Z17): the proxy's client id, the code shown, the approval page opened, polled every interval until the login times out (captured pending answer)", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n");
    const login = await run(["login", "opencode", "--timeout-seconds", "6"], undefined, { ACCOUNTS_PROXY_E2E_BROWSER_MODE: "ignore" });
    expect([login.code, login.stderr]).toEqual([1, "error: opencode: the device code was not approved in time; run `accounts-proxy login opencode`\n"]);
    // The page is the Console's own verification_uri_complete, replayed from the capture recorded before the rename;
    // the client id the proxy sends is the request body checked below.
    const recorded = (JSON.parse(captured("console/c2-device-flow.json", 0).body) as { verification_uri_complete: string }).verification_uri_complete;
    const page = new URL(recorded, upstreams.origin).href;
    expect(page).toStartWith(`${upstreams.origin}/console/device?user_code=%3CREDACTED:user_code%3E&client_id=`);
    expect(login.stdout).toBe(`Confirm this code on the page: <REDACTED:user_code>\nOpening your browser. If it does not open, visit:\n${page}\n`);
    expect(readFileSync(home.browserLog, "utf8")).toBe(`${page}\n`);
    const code = upstreams.find("/console/auth/device/code")[0]!;
    expect([code.body, code.headers["content-type"], code.headers["user-agent"]]).toEqual(["client_id=accounts-proxy&supports_org_scope=true", "application/x-www-form-urlencoded", "accounts-proxy/0.1.0"]);
    const polls = upstreams.find("/console/auth/device/token");
    expect(polls.map((p) => p.body).slice(-1)).toEqual(["grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=%3CREDACTED%3Adevice_code%3E&client_id=accounts-proxy"]);
    expect(existsSync(join(home.dir, "accounts-opencode.json"))).toBe(false);
  });

  test("device login edges: a browser that cannot start is only warned; the Console refusing the code or the poll fails the login; --manual/--new do not apply", async () => {
    home = await makeHome("providers:\n  opencode-go: {enabled: true}\n");
    upstreams.script("/console/auth/device/token", zenRefusal);
    const refusedPoll = await run(["login", "opencode-go", "--timeout-seconds", "30"], undefined, { PATH: join(home.dir, "no-such-dir") });
    expect([refusedPoll.code, refusedPoll.stderr]).toEqual([1, expect.stringContaining("error: opencode upstream HTTP 403: ")]);
    expect(readFileSync(join(home.dir, "logs", "proxy.log"), "utf8")).toContain("WARN opencode-go: could not open the browser");
    upstreams.script("/console/auth/device/code", zenRefusal);
    expect(await run(["login", "opencode-go"])).toMatchObject({ code: 1, stderr: expect.stringContaining("error: opencode upstream HTTP 403: ") });
    // A web page instead of the JSON answer (the committed Console API page stands for one).
    upstreams.script("/console/auth/device/code", () => new Response(spec("opencode-console-api.html"), { headers: { "content-type": "text/html" } }));
    expect(await run(["login", "opencode-go"])).toMatchObject({ code: 1, stderr: "error: opencode upstream HTTP 502: the device authorization answer lacks a field or names a non-HTTP page: {}\n" });
    expect(await run(["login", "opencode-go", "--new"])).toMatchObject({ code: 1, stderr: "error: opencode-go signs in with a device code; --manual and --new do not apply\n" });
  });

  test("key login (K3, K4): a service-account key checked against the workspace config (documented example); one account for both; a refused key (captured 401) stores nothing", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    // Any other refusal of the config read is an upstream error (the Console's captured 400 stands for one).
    upstreams.script("/console/api/v2/config", () => {
      const answer = captured("console/c0-go-chat.json");
      return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType } });
    });
    expect(await run(["login", "opencode", "--key"], "oc_sk_e2e\n")).toMatchObject({ code: 1, stderr: expect.stringContaining("error: opencode upstream HTTP 400: ") });
    const refused = await run(["login", "opencode", "--key"], "oc_sk_refused\n");
    expect([refused.code, refused.stderr]).toEqual([1, 'error: opencode: the Console refused the credential: HTTP 401 {"_tag":"Unauthorized"}; run `accounts-proxy login opencode`\n']);
    expect(existsSync(join(home.dir, "accounts-opencode.json"))).toBe(false);
    const login = await run(["login", "opencode-go", "--key"], "oc_sk_e2e\n");
    expect([login.code, login.stdout]).toEqual([0, expect.stringMatching(/^OpenCode Console API key \(opencode\.ai Console → Keys → service account → Add API Key; starts oc_sk_\): \nsigned in to opencode-go as key-[0-9a-f]{8} \(active account\)\n$/)]);
    expect(login.stdout).not.toContain("oc_sk_e2e");
    const config = upstreams.find("/console/api/v2/config").at(-1)!;
    expect([config.headers["authorization"], config.headers["user-agent"]]).toEqual(["Bearer oc_sk_e2e", "accounts-proxy/0.1.0"]);
    const stored = JSON.parse(readFileSync(join(home.dir, "accounts-opencode.json"), "utf8")) as { accounts: { provider: string; data: Record<string, unknown> }[] };
    expect([stored.accounts[0]!.provider, stored.accounts[0]!.data]).toEqual(["opencode", { workspaceHeaders: { opencode: { "x-opencode-org-id": "org_..." } }, apiKey: "oc_sk_e2e" }]);
    expect(existsSync(join(home.dir, "accounts-opencode-go.json"))).toBe(false);
    expect((await run(["account", "list", "opencode"])).stdout).toMatch(/^\* key-[0-9a-f]{8}\n$/);
    expect((await run(["account", "list", "opencode-go"])).stdout).toMatch(/^\* key-[0-9a-f]{8}\n$/);
  });

  test("native cells (Z12–Z15): bearer key on every route, the proxy's User-Agent, the workspace headers, the client's x-opencode-session; captured Console answers passed through", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    writeKeyAccount("opencode", { apiKey: "oc_sk_e2e", workspaceHeaders: { opencode: { "x-opencode-org-id": "org_e2e" } } });
    const s = await serve();
    const chat = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}`, "x-opencode-session": "ses_e2e" }, { model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] });
    expect([chat.status, chat.headers.get("x-opencode-log-id"), ((await chat.json()) as { error: { type: string } }).error.type]).toEqual([403, expect.any(String), "FreeTierError"]);
    const sent = upstreams.find("/inference/openai/v1/chat/completions")[0]!;
    expect([sent.headers["authorization"], sent.headers["user-agent"], sent.headers["x-opencode-org-id"], sent.headers["x-opencode-session"], JSON.parse(sent.body).model]).toEqual(["Bearer oc_sk_e2e", "accounts-proxy/0.1.0", "org_e2e", "ses_e2e", "big-pickle"]);
    const messages = await post(`${s.url}/anthropic/v1/messages`, { "x-api-key": s.token }, { model: "opencode/claude-haiku-4-5", max_tokens: 8, messages: [] });
    expect(messages.status).toBe(401);
    expect([upstreams.find("/inference/anthropic/v1/messages")[0]!.headers["authorization"], upstreams.find("/inference/anthropic/v1/messages")[0]!.headers["x-api-key"]]).toEqual(["Bearer oc_sk_e2e", undefined]);
    const gemini = await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:streamGenerateContent?alt=sse`, { "x-goog-api-key": s.token }, { contents: [] });
    expect(gemini.status).toBe(401);
    const google = upstreams.find("/inference/google/v1beta/models/gemini-3.6-flash:streamGenerateContent")[0]!;
    expect([google.search, google.headers["authorization"]]).toEqual(["?alt=sse", "Bearer oc_sk_e2e"]);
    const translated = await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode/big-pickle", input: "hi" });
    expect([translated.status, ((await translated.json()) as { error: { code: string } }).error.code]).toEqual([400, "unsupported_feature"]);
    // Z6: a model models.dev does not describe is forwarded in the client's format.
    const unknown = await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode/jev-1.13", input: "hi" });
    expect(unknown.status).toBe(401);
    // Go (Z15): without x-opencode-session the Console's captured 400; Go's workspace headers are its own (none here).
    const bare = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3-flash", messages: [] });
    expect([bare.status, ((await bare.json()) as { error: { type: string } }).error.type]).toEqual([400, "MissingSessionID"]);
    const go = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}`, "x-opencode-session": "ses_go" }, { model: "opencode-go/glm-5.3-flash", messages: [] });
    expect(go.status).toBe(401);
    const goSent = upstreams.find("/inference/go/v1/chat/completions").at(-1)!;
    expect([goSent.headers["x-opencode-session"], goSent.headers["x-opencode-org-id"], goSent.headers["authorization"]]).toEqual(["ses_go", undefined, "Bearer oc_sk_e2e"]);
    const goGemini = await post(`${s.url}/gemini/v1beta/models/opencode-go%2Fnew-model:generateContent`, { "x-goog-api-key": s.token }, { contents: [] });
    expect([goGemini.status, ((await goGemini.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode-go (no native endpoint for this format; the proxy does not translate between formats) cannot carry: gemini_format"]);
  });

  test("Z24: a client without x-opencode-session gets its conversation's own id or one derived from the first user turn", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    writeKeyAccount("opencode", { apiKey: "oc_sk_e2e" });
    const s = await serve();
    const session = (path: string) => upstreams.find(path).at(-1)!.headers["x-opencode-session"];
    const turn = { role: "user", content: "hi" };
    await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3-flash", messages: [{ role: "system", content: "s" }, turn] });
    const first = session("/inference/go/v1/chat/completions");
    expect(first).toMatch(/^ap_[0-9a-f]{16}$/);
    // The next request of the same conversation (history resent) carries the same id; Go then answers as with a session.
    const next = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3-flash", messages: [{ role: "system", content: "s" }, turn, { role: "assistant", content: "yo" }, { role: "user", content: "more" }] });
    expect([next.status, session("/inference/go/v1/chat/completions")]).toEqual([401, first]);
    // Claude Code: the session of metadata.user_id (as captured from claude-cli 2.1.29).
    await post(`${s.url}/anthropic/v1/messages`, { "x-api-key": s.token }, { model: "opencode-go/qwen3.8-flash", max_tokens: 8, metadata: { user_id: "user_ab12_account__session_0fae6fcb-7a48-4def-941f-6e06af96c972" }, messages: [turn] });
    expect(session("/inference/go/v1/messages")).toBe("0fae6fcb-7a48-4def-941f-6e06af96c972");
    // Responses: the client's prompt_cache_key (opencode sets its session affinity there); without one, the first user item.
    await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/gpt-5.6-luna", prompt_cache_key: "ses_affinity", input: "hi" });
    expect(session("/inference/go/v1/responses")).toBe("ses_affinity");
    await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/gpt-5.6-luna", input: [{ type: "function_call_output", call_id: "c", output: "o" }, { role: "user", content: "hi" }] });
    expect(session("/inference/go/v1/responses")).toMatch(/^ap_[0-9a-f]{16}$/);
    // Gemini (Zen): the first role-less content; a body that is not a JSON object gets no id (the upstream decides).
    await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:generateContent`, { "x-goog-api-key": s.token }, { contents: [{ parts: [{ text: "hi" }] }] });
    expect(session("/inference/google/v1beta/models/gemini-3.6-flash:generateContent")).toMatch(/^ap_[0-9a-f]{16}$/);
    // Bodies without a usable first turn get no id either (the upstream answers them).
    await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3-flash", messages: "hi" });
    await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/gpt-5.6-luna", input: 1 });
    await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:generateContent`, { "x-goog-api-key": s.token }, { contents: "hi" });
    expect([session("/inference/go/v1/chat/completions"), session("/inference/go/v1/responses"), session("/inference/google/v1beta/models/gemini-3.6-flash:generateContent")]).toEqual([undefined, undefined, undefined]);
    for (const body of ["[1]", "{"]) {
      await fetch(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:generateContent`, { method: "POST", headers: { "x-goog-api-key": s.token, "content-type": "application/json" }, body });
    }
    expect(upstreams.find("/inference/google/v1beta/models/gemini-3.6-flash:generateContent").slice(-2).map((r) => [r.body, r.headers["x-opencode-session"]])).toEqual([
      ["[1]", undefined],
      ["{", undefined],
    ]);
  });

  test("a stored device sign-in (Z18): its access token as the bearer credential and its workspace headers; no account needs a login", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
    const renewals = upstreams.find("/console/auth/device/token").length;
    const s = await serve();
    const none = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3", messages: [] });
    expect([none.status, ((await none.json()) as { error: { message: string } }).error.message]).toEqual([401, "opencode: no active account; run `accounts-proxy login opencode`"]);
    const headers = { opencode: { "x-opencode-org-id": "org_e2e" }, "opencode-go": { "x-opencode-org-id": "org_e2e" } };
    writeKeyAccount("opencode", { accessToken: "console-access", refreshToken: "console-refresh", expiresAt: Date.now() + 3_600_000, orgId: "org_e2e", workspaceHeaders: headers });
    const go = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}`, "x-opencode-session": "ses_go" }, { model: "opencode-go/glm-5.3-flash", messages: [] });
    expect(go.status).toBe(401);
    const sent = upstreams.find("/inference/go/v1/chat/completions").at(-1)!;
    expect([sent.headers["authorization"], sent.headers["x-opencode-org-id"]]).toEqual(["Bearer console-access", "org_e2e"]);
    expect(upstreams.find("/console/auth/device/token")).toHaveLength(renewals);
  });
});

describe("API keys imported from OpenCode (K5, rule Z22) and typed keys (K3)", () => {
  const authFile = (content: string) => {
    mkdirSync(join(home!.dir, "xdg-data", "opencode"), { recursive: true });
    writeFileSync(join(home!.dir, "xdg-data", "opencode", "auth.json"), content);
  };

  test("--from-opencode reads only API keys from OpenCode's auth.json (never writes it); --key prompts for one; checked by the vendor", async () => {
    home = await makeHome("providers:\n  openrouter: {enabled: true}\n  opencode: {enabled: true}\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n");
    const path = join(home.dir, "xdg-data", "opencode", "auth.json");
    expect(await run(["login", "openrouter", "--from-opencode"])).toMatchObject({ code: 1, stderr: `error: cannot read OpenCode's credential file ${path}: ENOENT\n` });
    // Without XDG_DATA_HOME, OpenCode's data directory is under the home directory (here the test's own).
    const underHome = await run(["login", "openrouter", "--from-opencode"], undefined, { XDG_DATA_HOME: "", HOME: home.dir });
    expect(underHome.stderr).toBe(`error: cannot read OpenCode's credential file ${join(home.dir, ".local", "share", "opencode", "auth.json")}: ENOENT\n`);
    authFile("[1]");
    expect(await run(["login", "openrouter", "--from-opencode"])).toMatchObject({ code: 1, stderr: `error: OpenCode stores no API key for openrouter in ${path}\n` });
    authFile("{");
    expect(await run(["login", "openrouter", "--from-opencode"])).toMatchObject({ code: 1, stderr: `error: OpenCode's credential file ${path} is not JSON\n` });
    const text = JSON.stringify({ openrouter: { type: "oauth", refresh: "r", access: "a", expires: 1 }, opencode: { type: "api", key: "oc_sk_imported" } });
    authFile(text);
    expect(await run(["login", "openrouter", "--from-opencode"])).toMatchObject({ code: 1, stderr: "error: OpenCode stores a sign-in for openrouter, not an API key; only API keys are imported (sign in with `accounts-proxy login openrouter`)\n" });
    authFile(JSON.stringify({ opencode: { type: "api", key: "oc_sk_imported" } }));
    expect(await run(["login", "openrouter", "--from-opencode"])).toMatchObject({ code: 1, stderr: `error: OpenCode stores no API key for openrouter in ${path}\n` });
    authFile(text.replace('{"type":"oauth","refresh":"r","access":"a","expires":1}', '{"type":"api","key":"sk-or-v1-imported"}'));
    const imported = await run(["login", "openrouter", "--from-opencode"]);
    expect([imported.code, imported.stdout]).toEqual([0, expect.stringMatching(/^signed in to openrouter as .+ \(active account\)\n$/)]);
    expect(upstreams.find("/api/v1/key").at(-1)!.headers["authorization"]).toBe("Bearer sk-or-v1-imported");
    expect(readFileSync(join(home.dir, "logs", "proxy.log"), "utf8")).toContain("INFO openrouter: API key imported from opencode");
    const typed = await run(["login", "openrouter", "--key"], "sk-or-v1-typed\n");
    expect([typed.code, typed.stdout.startsWith("OpenRouter API key (https://openrouter.ai/keys): \nsigned in to openrouter as ")]).toEqual([0, true]);
    expect(pool("openrouter").accounts.map((a) => a.data.apiKey).sort()).toEqual(["sk-or-v1-imported", "sk-or-v1-typed"]);
    const opencode = await run(["login", "opencode", "--from-opencode"]);
    expect(opencode.code).toBe(0);
    expect(pool("opencode").accounts[0]!.data.apiKey).toBe("oc_sk_imported");
    expect(readFileSync(join(home.dir, "xdg-data", "opencode", "auth.json"), "utf8")).toBe(text.replace('{"type":"oauth","refresh":"r","access":"a","expires":1}', '{"type":"api","key":"sk-or-v1-imported"}'));
    expect(await run(["login", "claude", "--key"])).toMatchObject({ code: 1, stderr: "error: claude has no API-key login\n" });
    expect(await run(["login", "openrouter", "--key", "--manual"])).toMatchObject({ code: 1, stderr: "error: openrouter signs in with an API key; --manual and --new do not apply\n" });
    expect(await run(["login", "openrouter", "--key", "--from-opencode"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--key and --from-opencode exclude each other") });
    upstreams.script("/api/v1/key", documented("/key", "get", "401"));
    expect(await run(["login", "openrouter", "--key"], "sk-or-v1-bad\n")).toMatchObject({ code: 1, stderr: expect.stringContaining("error: openrouter: the key was refused: HTTP 401") });
  });
});

describe("gateway edges", () => {
  test("Zen: the client's accept travels, generateContent without alt, countTokens and other Anthropic paths are refused, an empty key is refused, an account without a key needs a login", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n");
    expect(await run(["login", "opencode", "--key"], "\n")).toMatchObject({ code: 1, stderr: "error: opencode: no API key entered; run `accounts-proxy login opencode`\n" });
    writeKeyAccount("opencode", { apiKey: "oc_sk_e2e" });
    const s = await serve();
    await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}`, accept: "application/json" }, { model: "opencode/big-pickle", messages: [] });
    expect(upstreams.find("/inference/openai/v1/chat/completions").at(-1)!.headers["accept"]).toBe("application/json");
    await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:generateContent`, { "x-goog-api-key": s.token }, { contents: [] });
    expect(upstreams.find("/inference/google/v1beta/models/gemini-3.6-flash:generateContent").at(-1)!.search).toBe("");
    const count = await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:countTokens`, { "x-goog-api-key": s.token }, { contents: [] });
    expect([count.status, ((await count.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode cannot carry: countTokens"]);
    const batches = await post(`${s.url}/anthropic/v1/batches`, { "x-api-key": s.token }, { model: "opencode/claude-haiku-4-5" });
    expect([batches.status, ((await batches.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode has no native route /v1/batches"]);
    writeKeyAccount("opencode", {});
    const keyless = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode/big-pickle", messages: [] });
    expect([keyless.status, ((await keyless.json()) as { error: { message: string } }).error.message]).toEqual([401, "opencode: stored credential of key-e2e is unreadable; run `accounts-proxy login opencode`"]);
  });

  test("catalog fallbacks: the reference catalog or the list refused (captured gateway answer), a stale stored copy, an unreadable copy, an unwritable store", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n  openrouter: {enabled: true}\n");
    upstreams.script("/api.json", zenRefusal);
    upstreams.script("/inference/go/v1/models", zenRefusal);
    upstreams.script("/api/v1/models", documented("/models", "get", "500"));
    const listed = await run(["models"]);
    expect(listed.stdout.split("\n").filter((l) => l.startsWith("# "))).toEqual(["# openrouter: 459 models (built-in list: the live catalog was unavailable)", "# opencode: 84 models (live catalog)", "# opencode-go: 38 models (built-in list: the live catalog was unavailable)"]);
    // The built-in copy of the reference catalog still names the models and gives their formats.
    expect(listed.stdout).toContain("opencode/big-pickle  Big Pickle  context 200000 / output 32000\n");
    const log = readFileSync(join(home.dir, "logs", "proxy.log"), "utf8");
    expect(log).toContain("WARN model reference: http://127.0.0.1:");
    expect(log).toContain("/api.json HTTP 403)");
    expect(log).toContain("WARN openrouter: live model list unavailable (model list HTTP 500)");
    // A stale copy (older than 24 h) is the fallback when the live list fails; an unreadable copy is ignored.
    for (const dir of ["opencode-go", "openrouter"]) mkdirSync(join(home.dir, "state", dir), { recursive: true });
    writeFileSync(join(home.dir, "state", "opencode-go", "model-catalog.json"), JSON.stringify({ version: 2, fetchedAt: 1, models: [{ id: "stale", displayName: "Stale" }] }));
    writeFileSync(join(home.dir, "state", "openrouter", "model-catalog.json"), JSON.stringify({ version: 2, fetchedAt: 1, models: [{ id: 7 }] }));
    upstreams.script("/inference/go/v1/models", zenRefusal);
    const stale = await run(["models", "opencode-go"]);
    expect(stale.stdout).toBe("# opencode-go: 1 models (stored copy of the live catalog)\nopencode-go/stale  Stale\n");
    expect((await run(["models", "openrouter"])).stdout.split("\n")[0]).toBe("# openrouter: 459 models (live catalog)");
    chmodSync(join(home.dir, "state", "opencode"), 0o500);
    writeFileSync(join(home.dir, "state", "opencode", "model-catalog.json"), "", { flag: "a" });
    chmodSync(join(home.dir, "state", "opencode", "model-catalog.json"), 0o000);
    expect((await run(["models", "opencode"])).stdout.split("\n")[0]).toBe("# opencode: 84 models (live catalog)");
    const warned = readFileSync(join(home.dir, "logs", "proxy.log"), "utf8");
    expect(warned).toContain("WARN opencode: model list cache unreadable");
    expect(warned).toContain("WARN opencode: model list cache write failed");
    chmodSync(join(home.dir, "state", "opencode", "model-catalog.json"), 0o600);
  });

  test("openrouter: a refused code exchange and a refused key report (OpenRouter's documented error answers)", async () => {
    home = await makeHome("providers:\n  openrouter: {enabled: true}\n");
    upstreams.script("/api/v1/auth/keys", documented("/auth/keys", "post", "400"));
    const refused = await run(["login", "openrouter", "--timeout-seconds", "30"]);
    expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining("error: openrouter: key exchange failed: HTTP 400")]);
    writeKeyAccount("openrouter", { apiKey: "sk-or-v1-e2e" });
    upstreams.script("/api/v1/key", documented("/key", "get", "401"));
    expect(await run(["quota", "openrouter"])).toMatchObject({ code: 1, stderr: expect.stringContaining("openrouter: GET /key HTTP 401") });
  });
});

describe("cheaper-inference (rules C1–C9)", () => {
  test("with a stored key: the keyed model list, count_tokens and Chat forwarded with the bearer key; the wallet refused", async () => {
    home = await makeHome("providers:\n  cheaper-inference: {enabled: true}\n");
    writeKeyAccount("cheaper-inference", { apiKey: "ci_live_e2e" });
    // The keyed list answered with the committed public list (the same model fields, C3/C4).
    upstreams.script("/v1/models", () => new Response(spec("cheaper-inference-public-models.json"), { headers: { "content-type": "application/json" } }));
    expect((await run(["models", "cheaper-inference"])).stdout.split("\n")[0]).toBe("# cheaper-inference: 91 models (live catalog)");
    expect(upstreams.find("/v1/models").at(-1)!.headers["authorization"]).toBe("Bearer ci_live_e2e");
    const s = await serve();
    const count = await post(`${s.url}/anthropic/v1/messages/count_tokens`, { "x-api-key": s.token }, { model: "cheaper-inference/aion-3.0", messages: [] });
    expect(count.status).toBe(200);
    expect(upstreams.find("/v1/messages/count_tokens").at(-1)!.headers["authorization"]).toBe("Bearer ci_live_e2e");
    const chat = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "cheaper-inference/aion-3.0", messages: [] });
    expect(chat.status).toBe(404);
    expect(JSON.parse(upstreams.find("/v1/chat/completions").at(-1)!.body)).toEqual({ model: "aion-3.0", messages: [] });
    expect(await run(["quota", "cheaper-inference"])).toMatchObject({ code: 1, stderr: expect.stringContaining("cheaper-inference: GET /v1/account/balance HTTP 404") });
  });

  test("without a key the public list is read; a refused list falls back to the built-in list", async () => {
    home = await makeHome("providers:\n  cheaper-inference: {enabled: true}\n");
    // A captured gateway refusal (probe z0) stands for any non-200 answer: only the status is read.
    upstreams.script("/public/models", zenRefusal);
    expect((await run(["models", "cheaper-inference"])).stdout.split("\n")[0]).toBe("# cheaper-inference: 91 models (built-in list: the live catalog was unavailable)");
    expect(readFileSync(join(home.dir, "logs", "proxy.log"), "utf8")).toContain("WARN cheaper-inference: live model list unavailable (model list HTTP 403)");
  });

  test("a refused key stores nothing; without an account requests need a login; disabled gateways name enabled: true", async () => {
    home = await makeHome("providers:\n  cheaper-inference: {enabled: true}\n");
    const login = await run(["login", "cheaper-inference"], "ci_live_bad\n");
    expect([login.code, login.stderr]).toEqual([1, expect.stringContaining("error: cheaper-inference: the key was refused: HTTP 404")]);
    expect(upstreams.find("/v1/account")[0]!.headers["authorization"]).toBe("Bearer ci_live_bad");
    expect(await run(["login", "cheaper-inference", "--manual"])).toMatchObject({ code: 1, stderr: "error: cheaper-inference signs in with an API key; --manual and --new do not apply\n" });
    // Standard input that ends before a line is entered fails the prompt instead of waiting forever.
    expect(await run(["login", "cheaper-inference"])).toMatchObject({ code: 1, stderr: "error: standard input ended before a line was entered\n" });
    const s = await serve();
    const chat = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "cheaper-inference/aion-3.0", messages: [] });
    expect(chat.status).toBe(401);
    writeKeyAccount("cheaper-inference", {});
    const keyless = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "cheaper-inference/aion-3.0", messages: [] });
    expect([keyless.status, ((await keyless.json()) as { error: { message: string } }).error.message]).toEqual([401, "cheaper-inference: account key-e2e has no API key; run `accounts-proxy login cheaper-inference`"]);
    const disabled = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "openrouter/a/b", messages: [] });
    expect([disabled.status, ((await disabled.json()) as { error: { message: string } }).error.message]).toEqual([503, "openrouter is disabled; enable it with enabled: true in proxy.yaml"]);
  });
});
