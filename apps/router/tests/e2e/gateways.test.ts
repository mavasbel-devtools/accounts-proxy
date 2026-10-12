// The API-key gateways (plan P4.6), black-box through the real router process: catalogs from the vendors' committed
// public lists, the OpenRouter PKCE login (browser and headless) answered with OpenRouter's documented examples, key
// logins at the hidden prompt, native cells per model format (the bare model id, the key in each endpoint's header,
// the answer unchanged), translated cells refused, and the captured OpenCode gateway refusal passed through.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { makeHome, runRouter, startDaemon, type Daemon, type Home } from "@inference-router/test-support/e2e/router-process.ts";
import { captured, openRouterExample, ReplayUpstreams, spec } from "@inference-router/test-support/e2e/upstreams.ts";

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
const run = (argv: string[], input?: string) => runRouter(home!, argv, upstreams.seamEnv(), input === undefined ? undefined : async () => input);
async function serve(): Promise<{ url: string; token: string }> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, upstreams.seamEnv());
  return { url: daemon.url, token };
}
const pool = (provider: string) => JSON.parse(readFileSync(join(home!.dir, `accounts-${provider}.json`), "utf8")) as { activeId: string; accounts: { id: string; data: { apiKey: string } }[] };
/** The router's own account file, written directly (a key the vendor's check could not confirm without a capture). */
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
      "# opencode: 83 models (live catalog)",
      "# opencode-go: 38 models (live catalog)",
      "# cheaper-inference: 91 models (live catalog)",
    ]);
    expect(upstreams.find("/api.json")).toHaveLength(2);
    const s = await serve();
    const gemini = (await (await fetch(`${s.url}/gemini/v1beta/models`, { headers: { "x-goog-api-key": s.token } })).json()) as { models: { name: string; supportedGenerationMethods: string[] }[] };
    const methods = (name: string) => gemini.models.find((m) => m.name === `models/${name}`)!.supportedGenerationMethods;
    expect([methods("opencode/gemini-3.6-flash"), methods("opencode/big-pickle"), methods("openrouter/meta/muse-wonder")]).toEqual([["generateContent", "streamGenerateContent"], [], []]);
    const openai = await fetch(`${s.url}/openai/v1/models`, { headers: { authorization: `Bearer ${s.token}` } });
    // The daemon reads the copies the CLI stored a moment ago (fresh for 24 h).
    expect(openai.headers.get("x-router-models-source")).toBe("openrouter=cache,opencode=cache,opencode-go=cache,cheaper-inference=cache");
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
    expect([translated.status, ((await translated.json()) as { error: { message: string } }).error.message]).toEqual([400, "openrouter/a/b (it accepts openai-chat, openai-responses, anthropic-messages; translated cells arrive in P5) cannot carry: gemini_format"]);
  });

  test("headless login (--manual): no callback, the pasted code is exchanged", async () => {
    home = await makeHome("providers:\n  openrouter: {enabled: true}\n");
    const login = await run(["login", "openrouter", "--manual"], "pasted-code\n");
    expect(login.code).toBe(0);
    const url = new URL(login.stdout.split("\n").find((l) => l.startsWith("http://127.0.0.1"))!);
    expect([url.searchParams.has("callback_url"), url.searchParams.has("state"), url.searchParams.get("key_label")]).toEqual([false, false, "inference-router"]);
    expect((JSON.parse(upstreams.find("/api/v1/auth/keys").at(-1)!.body) as { code: string }).code).toBe("pasted-code");
  });
});

describe("opencode and opencode-go (rules Z1–Z11)", () => {
  test("Zen: the key at the hidden prompt (format checked, no request); each native format with its key header; the gateway's refusal passed through", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n");
    const refused = await run(["login", "opencode"], "ci_live_wrong\n");
    expect([refused.code, refused.stderr]).toEqual([1, "error: an OpenCode API key starts with oc_sk_ (or sk- for a legacy key)\n"]);
    const login = await run(["login", "opencode"], "oc_sk_e2e\n");
    expect([login.code, login.stdout]).toEqual([0, expect.stringMatching(/^OpenCode Zen API key \(opencode\.ai Console → API keys\): \nsigned in to opencode as key-[0-9a-f]{8} \(active account\)\n$/)]);
    expect(login.stdout).not.toContain("oc_sk_e2e");
    const s = await serve();
    const chat = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] });
    expect([chat.status, chat.headers.get("x-opencode-log-id"), await chat.json()]).toEqual([403, "e62b9215-5c2c-421e-946d-9bed164096e8", { type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }]);
    expect(upstreams.find("/zen/v1/chat/completions")[0]!.headers["authorization"]).toBe("Bearer oc_sk_e2e");
    await post(`${s.url}/anthropic/v1/messages`, { "x-api-key": s.token }, { model: "opencode/claude-haiku-4-5", max_tokens: 8, messages: [] });
    expect(upstreams.find("/zen/v1/messages")[0]!.headers["x-api-key"]).toBe("oc_sk_e2e");
    const gemini = await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:streamGenerateContent?alt=sse`, { "x-goog-api-key": s.token }, { contents: [] });
    expect(gemini.status).toBe(403);
    const sent = upstreams.find("/zen/v1/models/gemini-3.6-flash:streamGenerateContent")[0]!;
    expect([sent.search, sent.headers["x-goog-api-key"]]).toEqual(["?alt=sse", "oc_sk_e2e"]);
    const translated = await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode/big-pickle", input: "hi" });
    expect([translated.status, ((await translated.json()) as { error: { code: string } }).error.code]).toEqual([400, "unsupported_feature"]);
    // Z6: a model models.dev does not describe is forwarded in the client's format.
    const unknown = await post(`${s.url}/openai/v1/responses`, { authorization: `Bearer ${s.token}` }, { model: "opencode/jev-1.13", input: "hi" });
    expect(unknown.status).toBe(403);
  });

  test("Go: the key is checked against GET /usage; a refusal stores nothing; Go has no Gemini route", async () => {
    home = await makeHome("providers:\n  opencode-go: {enabled: true}\n");
    const login = await run(["login", "opencode-go"], "oc_sk_go\n");
    expect([login.code, login.stderr]).toEqual([1, expect.stringContaining("error: opencode-go: the key was refused: HTTP 404")]);
    expect(upstreams.find("/zen/go/v1/usage")[0]!.headers["authorization"]).toBe("Bearer oc_sk_go");
    const s = await serve();
    const gemini = await post(`${s.url}/gemini/v1beta/models/opencode-go%2Fnew-model:generateContent`, { "x-goog-api-key": s.token }, { contents: [] });
    expect([gemini.status, ((await gemini.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode-go (no native endpoint; translated cells arrive in P5) cannot carry: gemini_format"]);
    const noAccount = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode-go/glm-5.3", messages: [] });
    expect([noAccount.status, ((await noAccount.json()) as { error: { message: string } }).error.message]).toEqual([401, "opencode-go: no active account; run `inference-router login opencode-go`"]);
  });
});

describe("gateway edges", () => {
  test("Zen: the client's accept travels, generateContent without alt, countTokens and other Anthropic paths are refused, an empty key is refused, an account without a key needs a login", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n");
    expect(await run(["login", "opencode"], "\n")).toMatchObject({ code: 1, stderr: "error: opencode: no API key entered; run `inference-router login opencode`\n" });
    writeKeyAccount("opencode", { apiKey: "oc_sk_e2e" });
    const s = await serve();
    await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}`, accept: "application/json" }, { model: "opencode/big-pickle", messages: [] });
    expect(upstreams.find("/zen/v1/chat/completions").at(-1)!.headers["accept"]).toBe("application/json");
    await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:generateContent`, { "x-goog-api-key": s.token }, { contents: [] });
    expect(upstreams.find("/zen/v1/models/gemini-3.6-flash:generateContent").at(-1)!.search).toBe("");
    const count = await post(`${s.url}/gemini/v1beta/models/opencode%2Fgemini-3.6-flash:countTokens`, { "x-goog-api-key": s.token }, { contents: [] });
    expect([count.status, ((await count.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode cannot carry: countTokens"]);
    const batches = await post(`${s.url}/anthropic/v1/batches`, { "x-api-key": s.token }, { model: "opencode/claude-haiku-4-5" });
    expect([batches.status, ((await batches.json()) as { error: { message: string } }).error.message]).toEqual([400, "opencode has no native route /v1/batches"]);
    writeKeyAccount("opencode", {});
    const keyless = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "opencode/big-pickle", messages: [] });
    expect([keyless.status, ((await keyless.json()) as { error: { message: string } }).error.message]).toEqual([401, "opencode: account key-e2e has no API key; run `inference-router login opencode`"]);
  });

  test("catalog fallbacks: models.dev or the list refused (captured gateway answer), a stale stored copy, an unreadable copy, an unwritable store", async () => {
    home = await makeHome("providers:\n  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n  openrouter: {enabled: true}\n");
    upstreams.script("/api.json", zenRefusal);
    upstreams.script("/zen/go/v1/models", zenRefusal);
    upstreams.script("/api/v1/models", documented("/models", "get", "500"));
    const listed = await run(["models"]);
    expect(listed.stdout.split("\n").filter((l) => l.startsWith("# "))).toEqual(["# openrouter: 459 models (built-in list: the live catalog was unavailable)", "# opencode: 83 models (live catalog)", "# opencode-go: 38 models (built-in list: the live catalog was unavailable)"]);
    expect(listed.stdout).toContain("opencode/big-pickle  big-pickle\n");
    const log = readFileSync(join(home.dir, "logs", "router.log"), "utf8");
    expect(log).toContain("WARN opencode: models.dev unavailable (GET ");
    expect(log).toContain("WARN openrouter: live model list unavailable (model list HTTP 500)");
    // A stale copy (older than 24 h) is the fallback when the live list fails; an unreadable copy is ignored.
    for (const dir of ["opencode-go", "openrouter"]) mkdirSync(join(home.dir, "state", dir), { recursive: true });
    writeFileSync(join(home.dir, "state", "opencode-go", "model-catalog.json"), JSON.stringify({ version: 1, fetchedAt: 1, models: [{ id: "stale", displayName: "Stale" }] }));
    writeFileSync(join(home.dir, "state", "openrouter", "model-catalog.json"), JSON.stringify({ version: 1, fetchedAt: 1, models: [{ id: 7 }] }));
    upstreams.script("/zen/go/v1/models", zenRefusal);
    const stale = await run(["models", "opencode-go"]);
    expect(stale.stdout).toBe("# opencode-go: 1 models (stored copy of the live catalog)\nopencode-go/stale  Stale\n");
    expect((await run(["models", "openrouter"])).stdout.split("\n")[0]).toBe("# openrouter: 459 models (live catalog)");
    chmodSync(join(home.dir, "state", "opencode"), 0o500);
    writeFileSync(join(home.dir, "state", "opencode", "model-catalog.json"), "", { flag: "a" });
    chmodSync(join(home.dir, "state", "opencode", "model-catalog.json"), 0o000);
    expect((await run(["models", "opencode"])).stdout.split("\n")[0]).toBe("# opencode: 83 models (live catalog)");
    const warned = readFileSync(join(home.dir, "logs", "router.log"), "utf8");
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
    expect(readFileSync(join(home.dir, "logs", "router.log"), "utf8")).toContain("WARN cheaper-inference: live model list unavailable (model list HTTP 403)");
  });

  test("a refused key stores nothing; without an account requests need a login; disabled gateways name enabled: true", async () => {
    home = await makeHome("providers:\n  cheaper-inference: {enabled: true}\n");
    const login = await run(["login", "cheaper-inference"], "ci_live_bad\n");
    expect([login.code, login.stderr]).toEqual([1, expect.stringContaining("error: cheaper-inference: the key was refused: HTTP 404")]);
    expect(upstreams.find("/v1/account")[0]!.headers["authorization"]).toBe("Bearer ci_live_bad");
    expect(await run(["login", "cheaper-inference", "--manual"])).toMatchObject({ code: 1, stderr: "error: cheaper-inference signs in with an API key; --manual and --new do not apply\n" });
    const s = await serve();
    const chat = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "cheaper-inference/aion-3.0", messages: [] });
    expect(chat.status).toBe(401);
    const disabled = await post(`${s.url}/openai/v1/chat/completions`, { authorization: `Bearer ${s.token}` }, { model: "openrouter/a/b", messages: [] });
    expect([disabled.status, ((await disabled.json()) as { error: { message: string } }).error.message]).toEqual([503, "openrouter is disabled; enable it with enabled: true in router.yaml"]);
  });
});
