// Inference through the pi baseUrls (plan 2026-11-15-23-52 stage 4): a signed-in daemon, the served GET
// /pi/models.json as the model source, and one native cell per pi api — each built exactly as pi 1.5.2 builds it
// (product design P2). Every upstream is the replay server; the scripted answers below are its own queue
// (upstreams.script), never another server. Bodies are minimal: one short prompt, no streaming flags.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, writePool, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { GRANTED_SCOPES } from "@accounts-proxy/test-support/e2e/openai-signing.ts";
import { ReplayUpstreams, spec } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
const upstreams = new ReplayUpstreams();

// The seams this suite uses, read from tests/support/e2e/upstreams.ts and the e2e tests that use them:
//   - openai inference: POST /v1/responses (apps/proxy/tests/e2e/openai.test.ts, default replay 200 stream).
//   - cheaper-inference inference: POST /v1/chat/completions (apps/proxy/tests/e2e/gateways.test.ts records it;
//     the default replay 404s, so the suite scripts its 200 below — the seam itself exists).
//   - claude: POST /v1/messages; antigravity: POST /v1internal:streamGenerateContent (default replays 200).
// The keyed cheaper list and claude's live catalog share GET /v1/models, so one branching answer covers both reads.
const claudeCatalog = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "provider-claude", "tests", "fixtures", "plugin-6292741", "catalog-api-response.json"), "utf8");
const cheaperList = () => new Response(spec("cheaper-inference-public-models.json"), { headers: { "content-type": "application/json" } });
const claudeList = () => new Response(claudeCatalog, { headers: { "content-type": "application/json" } });
const modelLists = (_body: Record<string, unknown>, request: { headers: Record<string, string> }): Response => {
  upstreams.script("/v1/models", modelLists);
  return request.headers["authorization"] === "Bearer ci_live_e2e" ? cheaperList() : claudeList();
};

const ACCOUNT = { accessToken: "e2e-openai-access", refreshToken: "e2e-openai-refresh", expiresAt: Date.now() + 3_600_000, scopes: GRANTED_SCOPES, clientId: "oaiapp_e2e", subject: "e2e-subject", idToken: "x.y.z", email: "e2e@example.com" };

let home: Home;
let daemon: Daemon;
let token: string;
beforeAll(async () => {
  upstreams.start();
  upstreams.script("/v1/models", modelLists);
  // Authorized test-only deviation (recorded in the session record): on darwin the login spawns the real `open`
  // while the harness fakes only `xdg-open`, so no login callback can arrive. The daemon child's PATH has home.bin
  // first, so this `open` fake — exactly the form makeHome uses for `xdg-open` — is found before the system one.
  // On Linux CI browserCommand still uses `xdg-open`, so this file is inert there. All logins stay replay-only.
  home = await makeHome(["providers:", "  claude: {enabled: true, acknowledgeTermsRisk: true}", "  antigravity: {enabled: true, acknowledgeTermsRisk: true}", "  openai: {enabled: true, acknowledgeTermsRisk: true}", "  cheaper-inference: {enabled: true}", "  openrouter: {enabled: true}", "  opencode: {enabled: true}", "  opencode-go: {enabled: true}", ""].join("\n"));
  writeFileSync(join(home.bin, "open"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "..", "..", "..", "..", "tests", "support", "e2e", "fake-browser.ts")}" "$1"\n`);
  chmodSync(join(home.bin, "open"), 0o755);
  for (const provider of ["antigravity", "claude"]) {
    const login = await runProxy(home, ["login", provider, "--timeout-seconds", "30"], upstreams.seamEnv());
    expect(login.code).toBe(0);
  }
  writePool(home, "openai", { accounts: [{ provider: "openai", id: "oaiapp_e2e", label: "e2e@example.com", data: ACCOUNT }], activeId: "oaiapp_e2e" });
  writePool(home, "cheaper-inference", { accounts: [{ provider: "cheaper-inference", id: "key-e2e", label: "key-e2e", data: { apiKey: "ci_live_e2e" } }], activeId: "key-e2e" });
  // Gateway key pools in the gateways.test.ts writeKeyAccount form (fake keys; the live lists come from the
  // default replay seams: openrouter /api/v1/models and opencode /api.json. opencode-go shares the opencode pool.)
  writePool(home, "openrouter", { accounts: [{ provider: "openrouter", id: "key-e2e", label: "key-e2e", data: { apiKey: "sk-or-v1-e2e" } }], activeId: "key-e2e" });
  writePool(home, "opencode", { accounts: [{ provider: "opencode", id: "key-e2e", label: "key-e2e", data: { apiKey: "oc_sk_e2e" } }], activeId: "key-e2e" });
  token = (await runProxy(home, ["token"], upstreams.seamEnv())).stdout.trim();
  daemon = await startDaemon(home, upstreams.seamEnv());
});
afterAll(async () => {
  if (daemon !== undefined) await daemon.stop();
  if (home !== undefined) removeTemporary(home.dir);
  upstreams.stop();
});
afterEach(() => upstreams.reset());

type PiModel = { id: string; api: string; baseUrl: string };
type PiDocument = { providers: Record<string, { models: PiModel[] }> };

async function piModel(provider: string, api: string): Promise<PiModel> {
  const doc = (await (await fetch(`${daemon.url}/pi/models.json`, { headers: { authorization: `Bearer ${token}` } })).json()) as PiDocument;
  const model = doc.providers[provider]!.models.find((m) => m.api === api);
  expect(model).toBeDefined();
  return model!;
}

const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("pi inference routing", () => {
  test("claude × anthropic-messages: the replay upstream receives the request; the client gets 200 [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=positive]", async () => {
    const model = await piModel("ap-claude", "anthropic-messages");
    expect(model.baseUrl).toBe(`${daemon.url}/anthropic`);
    const before = upstreams.find("/v1/messages").length;
    const answer = await post(`${model.baseUrl}/v1/messages?beta=true`, { "x-api-key": token }, { model: model.id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    expect(answer.status).toBe(200);
    await answer.text();
    const sent = upstreams.find("/v1/messages");
    expect(sent.length).toBe(before + 1);
    expect(JSON.parse(sent.at(-1)!.body)["model"]).toBe(model.id.split("/")[1]);
  });

  test("claude × anthropic-messages: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=negative]", async () => {
    const model = await piModel("ap-claude", "anthropic-messages");
    const before = upstreams.find("/v1/messages").length;
    const answer = await post(`${model.baseUrl}/v1/messages?beta=true`, { "x-api-key": "wrong" }, { model: model.id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    expect(answer.status).toBe(401);
    expect(upstreams.find("/v1/messages")).toHaveLength(before);
  });

  test("antigravity × google-generative-ai: the replay upstream receives the request; the client gets 200 [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=positive]", async () => {
    const model = await piModel("ap-antigravity", "google-generative-ai");
    expect(model.baseUrl).toBe(`${daemon.url}/gemini/v1beta`);
    const before = upstreams.find("/v1internal:streamGenerateContent").length;
    const answer = await post(`${model.baseUrl}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`, { "x-goog-api-key": token }, {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "user", parts: [{ text: "be brief" }] },
      tools: [{ functionDeclarations: [{ name: "get_time", description: "time", parametersJsonSchema: { type: "object", properties: { tz: { type: "string" } } } }] }],
    });
    expect(answer.status).toBe(200);
    await answer.text();
    const sent = upstreams.find("/v1internal:streamGenerateContent");
    expect(sent.length).toBe(before + 1);
    expect((JSON.parse(sent.at(-1)!.body) as { model: string }).model).toBe(model.id.split("/")[1]!);
  });

  test("antigravity × google-generative-ai: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=negative]", async () => {
    const model = await piModel("ap-antigravity", "google-generative-ai");
    const before = upstreams.find("/v1internal:streamGenerateContent").length;
    const answer = await post(`${model.baseUrl}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`, { "x-goog-api-key": "wrong" }, { contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(answer.status).toBe(401);
    expect(upstreams.find("/v1internal:streamGenerateContent")).toHaveLength(before);
  });

  test("openai × openai-responses: the replay upstream receives the request; the client gets 200 [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=positive]", async () => {
    const model = await piModel("ap-openai", "openai-responses");
    expect(model.baseUrl).toBe(`${daemon.url}/openai/v1`);
    const before = upstreams.find("/v1/responses").length;
    const answer = await post(`${model.baseUrl}/responses`, { authorization: `Bearer ${token}` }, {
      model: model.id,
      store: false,
      input: [
        { role: "developer", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(answer.status).toBe(200);
    await answer.text();
    const sent = upstreams.find("/v1/responses");
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.headers["authorization"]).toBe("Bearer e2e-openai-access");
  });

  test("openai × openai-responses: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=negative]", async () => {
    const model = await piModel("ap-openai", "openai-responses");
    const before = upstreams.find("/v1/responses").length;
    const answer = await post(`${model.baseUrl}/responses`, { authorization: "Bearer wrong" }, { model: model.id, store: false, input: "hi" });
    expect(answer.status).toBe(401);
    expect(upstreams.find("/v1/responses")).toHaveLength(before);
  });

  test("cheaper-inference × openai-completions: the replay upstream receives the request; the client gets 200 [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=positive]", async () => {
    const model = await piModel("ap-cheaper-inference", "openai-completions");
    expect(model.baseUrl).toBe(`${daemon.url}/openai/v1`);
    upstreams.script("/v1/chat/completions", () => Response.json({ id: "chatcmpl-e2e", object: "chat.completion", created: 1, model: model.id, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const before = upstreams.find("/v1/chat/completions").length;
    const answer = await post(`${model.baseUrl}/chat/completions`, { authorization: `Bearer ${token}` }, { model: model.id, messages: [{ role: "user", content: "hi" }], store: false, max_completion_tokens: 16 });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("ok");
    const sent = upstreams.find("/v1/chat/completions");
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.headers["authorization"]).toBe("Bearer ci_live_e2e");
  });

  test("cheaper-inference × openai-completions: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=negative]", async () => {
    const model = await piModel("ap-cheaper-inference", "openai-completions");
    const before = upstreams.find("/v1/chat/completions").length;
    const answer = await post(`${model.baseUrl}/chat/completions`, { authorization: "Bearer wrong" }, { model: model.id, messages: [{ role: "user", content: "hi" }] });
    expect(answer.status).toBe(401);
    expect(upstreams.find("/v1/chat/completions")).toHaveLength(before);
  });
});
