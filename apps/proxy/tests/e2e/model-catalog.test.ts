// The detailed model list and the opencode configuration (plan 2026-10-16 C2–C4), black-box through the real proxy
// process: the providers' lists from their committed captures and built-in copies, the reference catalog from the
// committed extract of models.opencode.ai, the routes `/proxy/v1/models`, `/opencode/config.json` and
// `/.well-known/opencode`, the commands `models --json` and `opencode-config`, and the reference catalog's fallbacks.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";
import { ENTRY, makeHome, runProxy, startDaemon, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { GRANTED_SCOPES } from "@accounts-proxy/test-support/e2e/openai-signing.ts";
import { captured, ReplayUpstreams, spec } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(60_000);
/** The committed reference's openai models with one of opencode's 16 ChatGPT ids, in the reference's order (P4). */
const OPENAI_LISTED = ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.5", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol"].map((id) => `openai/${id}`);
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

const ALL = [
  "providers:",
  "  claude: {enabled: true, acknowledgeTermsRisk: true}",
  "  antigravity: {enabled: true, acknowledgeTermsRisk: true}",
  "  openai: {enabled: true, acknowledgeTermsRisk: true}",
  "  openrouter: {enabled: true}",
  "  opencode: {enabled: true}",
  "  opencode-go: {enabled: true}",
  "  cheaper-inference: {enabled: true}",
  "",
].join("\n");
const run = (argv: string[]) => runProxy(home!, argv, upstreams.seamEnv());
/** Reads of the reference catalog since `from` (the replay server keeps every request of the file). */
const referenceReads = (from: number) => upstreams.find("/api.json").length - from;
const schema = JSON.parse(spec("opencode-config-schema.json")) as Record<string, unknown>;
/** The captured OpenCode gateway refusal (probe z0) and a committed vendor list, as answers at the reference address. */
const refusal = () => {
  const answer = captured("gateways/z0-opencode-keyless-none.json");
  return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType } });
};
const notReference = () => new Response(spec("opencode-zen-models.json"), { headers: { "content-type": "application/json" } });

type Catalog = { provider: string; source: string; referenceSource?: string; error?: { code: string }; models: { id: string; name: string; sources: Record<string, string>; cost?: unknown }[] };

describe("detailed model list and opencode configuration", () => {
  test("models --json and opencode-config: every provider; a provider without an account is unavailable; the configuration passes opencode's schema", async () => {
    home = await makeHome(ALL);
    const reads = upstreams.find("/api.json").length;
    const listed = await run(["models", "--json"]);
    expect([listed.code, listed.stderr]).toEqual([0, ""]);
    const catalogs = (JSON.parse(listed.stdout) as { catalogs: Catalog[] }).catalogs;
    expect(catalogs.map((c) => [c.provider, c.source, c.referenceSource])).toEqual([
      ["claude", "static", "live"],
      ["antigravity", "unavailable", "live"],
      ["openai", "live", "live"],
      ["openrouter", "live", "live"],
      ["opencode", "live", "live"],
      ["opencode-go", "live", "live"],
      ["cheaper-inference", "live", undefined],
    ]);
    expect(catalogs[1]!.error!.code).toBe("provider_auth_required");
    const haiku = catalogs[0]!.models.find((m) => m.id === "claude/claude-haiku-4-5-20251001")!;
    expect([haiku.name, haiku.sources["name"], haiku.cost]).toEqual(["Claude Haiku 4.5", "provider:claude", undefined]);
    // One read of the reference catalog per process: the OpenCode formats and the details share it.
    expect(referenceReads(reads)).toBe(1);
    const lines = (await run(["models"])).stdout.split("\n").filter((l) => l.startsWith("# antigravity"));
    expect(lines).toEqual(["# antigravity: 0 models (unavailable: antigravity: no active account; run `accounts-proxy login antigravity`)"]);

    const generated = await run(["opencode-config"]);
    expect(generated.code).toBe(0);
    const config = JSON.parse(generated.stdout) as { providers: Record<string, { models: Record<string, { modelID: string; settings: { baseURL: string }; compatibility?: object }> }> };
    expect(validate(schema, config)).toEqual([]);
    expect(Object.keys(config.providers)).toEqual(["ap-claude", "ap-openai", "ap-openrouter", "ap-opencode", "ap-opencode-go", "ap-cheaper-inference"]);
    expect(config.providers["ap-claude"]!.models["claude-haiku-4-5-20251001"]!.settings.baseURL).toBe(`http://127.0.0.1:${home.port}/anthropic/v1`);
    // Rule O6 (live C6): opencode features the subscription cells refuse are switched off per model.
    const compatibilities = (provider: string) => [...new Set(Object.values(config.providers[provider]!.models).map((m) => JSON.stringify(m.compatibility)))];
    expect(compatibilities("ap-claude")).toEqual([JSON.stringify({ supportsThinkingBlockBinding: false, supportsEffortUpdates: false })]);
    expect(compatibilities("ap-openai")).toEqual([JSON.stringify({ supportsEffortUpdates: false })]);
    expect((await run(["opencode-config", "x"])).code).toBe(2);
    expect((await run(["models", "--json", "--json"])).code).toBe(2);
  });

  test("the daemon: the well-known manifest is open; the configuration and the detailed list need the token; plain JSON errors", async () => {
    home = await makeHome(ALL);
    const reads = upstreams.find("/api.json").length;
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const manifest = (await (await fetch(`${daemon.url}/.well-known/opencode`)).json()) as { auth: { command: string[]; env: string }; remote_config: { url: string; headers: Record<string, string> } };
    expect(manifest).toEqual({
      auth: { command: ["env", `ACCOUNTS_PROXY_HOME=${home.dir}`, process.execPath, ENTRY, "token"], env: "ACCOUNTS_PROXY_TOKEN" },
      remote_config: { url: `${daemon.url}/opencode/config.json`, headers: { authorization: "Bearer {env:ACCOUNTS_PROXY_TOKEN}" } },
    });
    expect((await fetch(`${daemon.url}/.well-known/opencode`, { method: "POST" })).status).toBe(404);
    const unauthorized = await fetch(`${daemon.url}/opencode/config.json`);
    expect([unauthorized.status, await unauthorized.json()]).toEqual([401, { error: { code: "unauthorized", message: "missing or invalid accounts-proxy token" } }]);
    const auth = { authorization: `Bearer ${token}` };
    const config = await fetch(`${daemon.url}/opencode/config.json`, { headers: auth });
    expect(validate(schema, await config.json())).toEqual([]);
    const one = (await (await fetch(`${daemon.url}/proxy/v1/models?provider=cheaper-inference`, { headers: auth })).json()) as { catalogs: Catalog[] };
    expect(one.catalogs.map((c) => [c.provider, c.models.length])).toEqual([["cheaper-inference", 91]]);
    const unknown = await fetch(`${daemon.url}/proxy/v1/models?provider=nope`, { headers: auth });
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: { code: "invalid_request", message: 'unknown provider "nope"' } }]);
    const posted = await fetch(`${daemon.url}/proxy/v1/models`, { method: "POST", headers: auth });
    expect([posted.status, await posted.json()]).toEqual([404, { error: { code: "not_found", message: "no route POST /proxy/v1/models" } }]);
    const missing = await fetch(`${daemon.url}/proxy/v1/models?provider=antigravity`, { headers: auth });
    expect(missing.status).toBe(401);
    // One read for the daemon's life: the later lists use the copy it keeps.
    expect(referenceReads(reads)).toBe(1);
  });

  test("reference fallbacks: a stale stored copy, the built-in copy, a document without reference providers, a malformed or unusable stored copy", async () => {
    home = await makeHome("providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n");
    const state = join(home.dir, "state");
    const copy = join(state, "model-reference.json");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const source = async () => ((JSON.parse((await run(["models", "--json"])).stdout) as { catalogs: Catalog[] }).catalogs[0]!.referenceSource);
    writeFileSync(copy, JSON.stringify({ version: 1, fetchedAt: 1, catalog: { anthropic: { "claude-haiku-4-5-20251001": { name: "Stale Haiku" } } } }));
    upstreams.script("/api.json", refusal);
    expect(await source()).toBe("cache");
    for (const bad of ["[]", '{"version":2,"fetchedAt":1,"catalog":{}}', '{"version":1,"fetchedAt":"1","catalog":{}}', '{"version":1,"fetchedAt":1,"catalog":[]}']) {
      writeFileSync(copy, bad);
      upstreams.script("/api.json", refusal);
      expect(await source()).toBe("static");
    }
    for (const document of [notReference, () => Response.json([])]) {
      upstreams.script("/api.json", document);
      writeFileSync(copy, "[]");
      expect(await source()).toBe("static");
    }
    const log = readFileSync(join(home.dir, "logs", "proxy.log"), "utf8");
    expect(log).toContain("/api.json: no reference provider in the document)");
    // A directory where the copy belongs: unreadable, and the new copy cannot be written; the live read still answers.
    unlinkSync(copy);
    mkdirSync(copy);
    expect(await source()).toBe("live");
    const warned = readFileSync(join(home.dir, "logs", "proxy.log"), "utf8");
    expect(warned).toContain("WARN model reference: cache unreadable");
    expect(warned).toContain("WARN model reference: cache write failed");
  });

  test("the shapes the lists may take: each provider's own list and the reference catalog, through the configuration and its variants", async () => {
    home = await makeHome(ALL);
    for (const provider of ["claude", "antigravity"]) expect((await run(["login", provider, "--timeout-seconds", "30"])).code).toBe(0);
    // An OpenAI account as the sign-in stores it (openai.test.ts covers the sign-in itself).
    const account = { accessToken: "e2e-openai-access", refreshToken: "e2e-openai-refresh", expiresAt: Date.now() + 3_600_000, scopes: GRANTED_SCOPES, clientId: "oaiapp_e2e", subject: "e2e-subject", idToken: "x.y.z", email: "e2e@example.com" };
    writeFileSync(join(home.dir, "accounts-openai.json"), JSON.stringify({ accounts: [{ provider: "openai", id: "oaiapp_e2e", label: "e2e@example.com", data: account }], activeId: "oaiapp_e2e" }), { mode: 0o600 });
    if (existsSync(join(home.dir, "state", "model-reference.json"))) unlinkSync(join(home.dir, "state", "model-reference.json"));
    // A fresh stored Claude list whose entry states no capabilities and no limits (the type allows it; every list the
    // proxy fetches fills them, so only a stored copy can lack them).
    mkdirSync(join(home.dir, "state", "claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home.dir, "state", "claude", "model-catalog.json"), JSON.stringify({ version: 2, fetchedAt: Date.now(), models: [{ id: "claude-edge-nocaps", displayName: "Edge", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] }));
    scriptShapes();
    const listed = await run(["models", "--json"]);
    expect([listed.code, listed.stderr]).toEqual([0, ""]);
    const catalogs = (JSON.parse(listed.stdout) as { catalogs: { provider: string; models: Record<string, unknown>[] }[] }).catalogs;
    const model = (provider: string, id: string) => catalogs.find((c) => c.provider === provider)!.models.find((m) => m["id"] === `${provider}/${id}`)!;
    // Each list states only what it carries: no capabilities, a media type marked false, an empty effort, no parameters, no prices.
    expect(model("claude", "claude-edge-nocaps")["input"]).toBeUndefined();
    // A model whose lists state no limits has none in the Anthropic list or the Gemini list either.
    const token = (await run(["token"])).stdout.trim();
    daemon = await startDaemon(home, upstreams.seamEnv());
    const anthropic = (await (await fetch(`${daemon.url}/anthropic/v1/models`, { headers: { "x-api-key": token } })).json()) as { data: { id: string; max_input_tokens: number | null; max_tokens: number | null }[] };
    expect(anthropic.data.find((m) => m.id === "claude/claude-edge-nocaps")).toMatchObject({ max_input_tokens: null, max_tokens: null });
    const geminiList = (await (await fetch(`${daemon.url}/gemini/v1beta/models`, { headers: { "x-goog-api-key": token } })).json()) as { models: Record<string, unknown>[] };
    const limits = geminiList.models.find((m) => m["name"] === "models/claude/claude-edge-nocaps")!;
    expect([limits["inputTokenLimit"], limits["outputTokenLimit"]]).toEqual([undefined, undefined]);
    await daemon.stop();
    daemon = undefined;
    expect(model("antigravity", "gemini-edge")["input"]).toEqual(["text"]);
    // OpenAI's list is opencode's (recon gap P4): the reference's openai models with an allowed id, nothing else.
    expect(catalogs.find((c) => c.provider === "openai")!.models.map((m) => m["id"])).toEqual(OPENAI_LISTED);
    expect(model("openrouter", "meta/edge")["toolCall"]).toBeUndefined();
    expect([model("cheaper-inference", "edge-image")["input"], model("cheaper-inference", "edge-image")["cost"]]).toEqual([undefined, undefined]);
    expect(model("cheaper-inference", "edge-numbers")["cost"]).toEqual([{ input: 1.5, output: 3 }]);
    // The reference's shapes: unknown media and options left out, a cost without an output price, malformed tiers.
    expect(model("opencode", "claude-3-7-sonnet-edge")).toMatchObject({ interleavedField: "reasoning_content", reasoningOptions: [{ type: "effort", values: ["low", "high"] }] });
    expect(model("opencode", "claude-3-7-sonnet-edge")["cost"]).toBeUndefined();
    expect(model("opencode", "gemini-edge-budget")["cost"]).toEqual([{ input: 1, output: 2 }]);

    const config = JSON.parse((await run(["opencode-config"])).stdout) as { providers: Record<string, { models: Record<string, { variants: { id: string }[] }> }> };
    expect(validate(schema, config)).toEqual([]);
    const variants = (id: string) => config.providers["ap-opencode"]!.models[id]!.variants.map((v) => v.id);
    expect([
      variants("claude-3-7-sonnet-edge"),
      variants("claude-opus-4-5-tiny"),
      variants("claude-fable-5-toggle"),
      variants("claude-sonnet-4-5-toggle"),
      variants("claude-haiku-4-tiny"),
      variants("claude-sonnet-5-one"),
      variants("claude-sonnet-5-none"),
      variants("gpt-edge-toggle"),
      variants("gemini-edge-toggle"),
      variants("gemini-edge-budget"),
    ]).toEqual([["high", "max"], [], [], ["none", "thinking"], [], [], ["none", "high"], [], ["none", "thinking"], ["high", "max"]]);
    expect(config.providers["ap-opencode"]!.models["edge-xai"]).toBeUndefined();
    expect(Object.values(config.providers["ap-antigravity"]!.models).every((m) => m.variants.length === 0)).toBe(true);

    // A document without the provider (O5: the provider's list is the reference's): the built-in list answers.
    for (const stored of ["model-reference.json", "opencode/model-catalog.json"]) unlinkSync(join(home.dir, "state", stored));
    upstreams.script("/api.json", () => Response.json({ anthropic: JSON.parse(spec("models-opencode-reference.json")).anthropic }));
    const without = (JSON.parse((await run(["models", "opencode", "--json"])).stdout) as { catalogs: { source: string; models: { id: string; formats: string[] }[] }[] }).catalogs[0]!;
    expect([without.source, without.models.find((m) => m.id === "opencode/big-pickle")!.formats]).toEqual(["static", ["openai-chat"]]);
    // A defect while listing (an account file that is a directory) is never hidden as `unavailable`.
    unlinkSync(join(home.dir, "accounts-antigravity.json"));
    mkdirSync(join(home.dir, "accounts-antigravity.json"));
    const broken = await run(["models"]);
    expect([broken.code, broken.stderr]).toEqual([1, expect.stringContaining("EISDIR")]);
  });
});

describe("model-list age and refresh (plan 2026-10-26 R1–R2)", () => {
  const OPENROUTER = "/api/v1/models";
  const reads = (path: string) => upstreams.find(path).length;
  const firstLine = (stdout: string) => stdout.split("\n")[0];
  /** The `# <provider>: …` header lines only (the model rows are the committed lists'). */
  const headers = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("# "));

  test("without a daemon: `models --refresh` reads every list now in this process; a list younger than the age is reused", async () => {
    home = await makeHome(`modelListMaxAgeMinutes: 1440\n${ALL}`);
    expect((await run(["models", "openrouter"])).code).toBe(0);
    const listed = reads(OPENROUTER);
    // Within modelListMaxAgeMinutes the stored copy answers; no read.
    expect(headers((await run(["models", "openrouter"])).stdout)).toEqual(["# openrouter: 459 models (stored copy of the live catalog)"]);
    expect(reads(OPENROUTER)).toBe(listed);

    const reference = reads("/api.json");
    const refreshed = await run(["models", "--refresh"]);
    expect([refreshed.code, refreshed.stderr]).toEqual([0, ""]);
    expect(firstLine(refreshed.stdout)).toBe(`no daemon at http://127.0.0.1:${home.port}: refreshed by this process (the stored copies a daemon reads when it starts)`);
    const lines = headers(refreshed.stdout);
    expect(lines).toContain("# openrouter: 459 models (live catalog)");
    // Antigravity has no account: `unavailable` in a refresh of every provider, as in a listing.
    expect(lines).toContain("# antigravity: 0 models (unavailable: antigravity: no active account; run `accounts-proxy login antigravity`)");
    expect([reads(OPENROUTER) - listed, reads("/api.json") - reference]).toEqual([1, 1]);

    // A provider without a reference provider: its list only, the reference catalog is not read.
    const before = [reads("/public/models"), reads("/api.json")];
    const cheaper = JSON.parse((await run(["models", "cheaper-inference", "--refresh", "--json"])).stdout) as { refreshedBy: string; url: string; catalogs: Catalog[] };
    expect([cheaper.refreshedBy, cheaper.url, cheaper.catalogs.map((c) => [c.provider, c.source])]).toEqual(["this process", `http://127.0.0.1:${home.port}`, [["cheaper-inference", "live"]]]);
    expect([reads("/public/models") - before[0]!, reads("/api.json") - before[1]!]).toEqual([1, 0]);

    // Asked by name, the provider's own error; a defect in a refresh of every provider is never hidden.
    const named = await run(["models", "antigravity", "--refresh"]);
    expect([named.code, named.stderr]).toEqual([1, "error: antigravity: no active account; run `accounts-proxy login antigravity`\n"]);
    mkdirSync(join(home.dir, "accounts-antigravity.json"));
    const broken = await run(["models", "--refresh"]);
    expect([broken.code, broken.stderr]).toEqual([1, expect.stringContaining("EISDIR")]);
  });

  test("with a daemon: `models --refresh` asks the daemon, whose memory then answers; its errors are reported", async () => {
    home = await makeHome(ALL);
    daemon = await startDaemon(home, upstreams.seamEnv());
    const listed = reads(OPENROUTER);
    const refreshed = await run(["models", "openrouter", "--refresh"]);
    expect([refreshed.code, firstLine(refreshed.stdout), headers(refreshed.stdout)]).toEqual([0, `refreshed by the daemon at ${daemon.url}`, ["# openrouter: 459 models (live catalog)"]]);
    const json = JSON.parse((await run(["models", "openrouter", "--refresh", "--json"])).stdout) as { refreshedBy: string; catalogs: Catalog[] };
    expect([json.refreshedBy, json.catalogs[0]!.source]).toEqual(["daemon", "live"]);
    expect(reads(OPENROUTER) - listed).toBe(2);

    const refused = await run(["models", "antigravity", "--refresh"]);
    expect([refused.code, refused.stderr]).toEqual([
      1,
      `error: the daemon at ${daemon.url} answered the refresh with HTTP 401: antigravity: no active account; run \`accounts-proxy login antigravity\`\n`,
    ]);
  });

  test("something else on the daemon's port, an unreadable proxy token, a model-list age that is not a positive integer", async () => {
    home = await makeHome(ALL);
    const answers = [new Response("boom", { status: 500 }), Response.json({ catalogs: 7 })];
    const other = Bun.serve({ hostname: "127.0.0.1", port: home.port, fetch: () => answers.shift()! });
    try {
      const plain = await run(["models", "--refresh"]);
      expect([plain.code, plain.stderr]).toEqual([1, `error: the daemon at http://127.0.0.1:${home.port} answered the refresh with HTTP 500\n`]);
      const shapeless = await run(["models", "--refresh"]);
      expect([shapeless.code, shapeless.stderr]).toEqual([1, `error: the daemon at http://127.0.0.1:${home.port} answered the refresh with HTTP 200: the answer has no catalogs\n`]);
    } finally {
      await other.stop(true);
    }
    writeFileSync(join(home.dir, "token.json"), '{"token":""}');
    const token = await run(["models", "--refresh"]);
    expect([token.code, token.stderr.includes("token.json is not valid")]).toEqual([1, true]);

    for (const age of ["x", "1.5", "0"]) {
      writeFileSync(join(home.dir, "proxy.yaml"), `modelListMaxAgeMinutes: ${age}\n${ALL}`);
      const result = await run(["help"]);
      expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("modelListMaxAgeMinutes must be a positive integer (minutes)")]);
    }
    for (const [setting, message] of [
      ["exchangeLog: on", "exchangeLog must be a mapping"],
      ["exchangeLog: {retentionDays: 0}", "exchangeLog.retentionDays must be a positive integer (days)"],
    ] as const) {
      writeFileSync(join(home.dir, "proxy.yaml"), `${setting}\n${ALL}`);
      const result = await run(["help"]);
      expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
    }
  });

  test("the exchange log (plan 2026-10-26 X1-X5): every list read recorded; a day file past exchangeLog.retentionDays is removed", async () => {
    home = await makeHome(`exchangeLog: {retentionDays: 2}\n${ALL}`);
    const logs = join(home.dir, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "exchanges-2020-01-01.jsonl"), "{}\n");
    writeFileSync(join(logs, "exchanges-notes.txt"), "kept: not a day file\n");
    expect((await run(["models", "--refresh"])).code).toBe(0);
    const files = readdirSync(logs).filter((name) => name.startsWith("exchanges-")).sort();
    expect(files).toEqual(["exchanges-notes.txt", `exchanges-${new Date().toISOString().slice(0, 10)}.jsonl`].sort());
    const records = readFileSync(join(logs, files.find((f) => f.endsWith(".jsonl"))!), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((r) => r["kind"] === "upstream-request" && String(r["url"]).endsWith(OPENROUTER))).toBe(true);
    expect(records.every((r) => r["schema"] === "accounts-proxy-exchange/1")).toBe(true);
  });
});

/** Committed lists with one row of each shape added (the rows are this test's; every other row is the vendor's). */
function scriptShapes(): void {
  const json = (value: unknown): Response => Response.json(value);
  const body = (relative: string) => JSON.parse(captured(relative).body) as Record<string, unknown>;
  const antigravity = body("e5/fetch-available-models.json") as { models: Record<string, Record<string, unknown>> };
  const first = Object.values(antigravity.models)[0]!;
  antigravity.models["gemini-edge"] = { ...first, displayName: "Edge", supportsImages: false, supportsVideo: false, supportedMimeTypes: { "image/png": false, "text/plain": true } };
  upstreams.script("/v1internal:fetchAvailableModels", () => json(antigravity));
  const openrouter = JSON.parse(spec("openrouter-models.json")) as { data: Record<string, unknown>[] };
  openrouter.data.push({ ...openrouter.data[0], id: "meta/edge", supported_parameters: undefined });
  upstreams.script("/api/v1/models", () => json(openrouter));
  const cheaper = JSON.parse(spec("cheaper-inference-public-models.json")) as { models: Record<string, unknown>[] };
  const row = cheaper.models[0]!;
  cheaper.models.push(
    { ...row, id: "edge-image", model_type: "image", supports_vision: undefined, supports_video: undefined, supports_reasoning: undefined, input_per_million: null },
    { ...row, id: "edge-numbers", input_per_million: 1.5, output_per_million: 3, cache_read_per_million: null, cache_write_per_million: null },
  );
  upstreams.script("/public/models", () => json(cheaper));
  const reference = JSON.parse(spec("models-opencode-reference.json")) as Record<string, { npm?: string; models: Record<string, unknown> }>;
  const anthropic = { provider: { npm: "@ai-sdk/anthropic" } };
  const edges: Record<string, unknown> = {
    "claude-3-7-sonnet-edge": { ...anthropic, name: "Edge 3.7", reasoning_options: [{ type: "effort", values: ["low", "high"] }, 7, { type: "unknown" }], limit: { context: 200_000, output: 64_000 }, interleaved: "reasoning_content", modalities: { input: ["smell"] }, cost: { input: 1 } },
    "claude-opus-4-5-tiny": { ...anthropic, reasoning_options: [{ type: "effort", values: ["low"] }], limit: { output: 1000 } },
    "claude-fable-5-toggle": { ...anthropic, reasoning_options: [{ type: "toggle" }] },
    "claude-sonnet-4-5-toggle": { ...anthropic, reasoning_options: [{ type: "toggle" }], limit: { output: 64_000 } },
    "claude-haiku-4-tiny": { ...anthropic, reasoning_options: [{ type: "toggle" }], limit: { output: 500 } },
    "claude-sonnet-5-one": { ...anthropic, reasoning_options: [{ type: "budget_tokens" }], limit: { output: 1 } },
    "claude-sonnet-5-none": { ...anthropic, reasoning_options: [{ type: "effort", values: ["none", "high"] }] },
    "gpt-edge-toggle": { provider: { npm: "@ai-sdk/openai" }, reasoning_options: [{ type: "toggle" }] },
    "gemini-edge-toggle": { provider: { npm: "@ai-sdk/google" }, reasoning_options: [{ type: "toggle" }] },
    "gemini-edge-budget": {
      provider: { npm: "@ai-sdk/google" },
      reasoning_options: [{ type: "budget_tokens", min: 1024, max: 8192 }],
      limit: { output: 65_536 },
      cost: { input: 1, output: 2, tiers: ["x", { tier: { type: "context", size: 0 }, input: 1, output: 2 }, { tier: { type: "context", size: 1000 }, input: 1 }] },
    },
    "edge-xai": { provider: { npm: "@ai-sdk/xai" } },
    broken: 7,
  };
  Object.assign(reference["opencode"]!.models, edges);
  delete reference["opencode-go"]!.npm;
  upstreams.script("/api.json", () => json(reference));
}

