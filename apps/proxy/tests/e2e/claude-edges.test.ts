// Claude edge paths, black-box: the per-model envelope built from live catalog capabilities, every thinking /
// output_config / system shape the transform accepts, tool-result turns without ids, an account without an account
// uuid, upstream answers without a body or a content type, an unwritable catalog cache and the refresh lock.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { E2E_TEST_TIMEOUT_MS } from "@accounts-proxy/scripts/gate/run-tests.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, readPool, runProxy, startDaemon, writePool, type Daemon, type Home, loggedEventually } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { jsonResponse, ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
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
    if (existsSync(join(home.dir, "state", "claude"))) chmodSync(join(home.dir, "state", "claude"), 0o700);
    removeTemporary(home.dir);
  }
  home = undefined;
});

const repo = join(import.meta.dir, "..", "..", "..", "..");
const MESSAGES = "/v1/messages";
const claudeToken = (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const base = JSON.parse(readFileSync(join(repo, "packages", "provider-claude", "tests", "fixtures", "plugin-6292741", "refresh-response.json"), "utf8")) as Record<string, unknown>;
  for (const key of drop) delete base[key];
  return () => jsonResponse({ ...base, ...over });
};
const run = (argv: string[]) => runProxy(home!, argv, upstreams.seamEnv());
async function login(): Promise<void> {
  const result = await run(["login", "claude", "--timeout-seconds", "30"]);
  if (result.code !== 0) throw new Error(result.stderr);
}
async function serve(): Promise<{ url: string; token: string }> {
  const token = (await run(["token"])).stdout.trim();
  daemon = await startDaemon(home!, upstreams.seamEnv());
  return { url: daemon.url, token };
}
type Session = { url: string; token: string };
const post = (s: Session, path: string, body: Record<string, unknown>) =>
  fetch(`${s.url}/anthropic${path}`, { method: "POST", headers: { "x-api-key": s.token, "content-type": "application/json" }, body: JSON.stringify(body) });
const user = [{ role: "user", content: "hi" }];
async function sentFor(s: Session, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await post(s, MESSAGES, { messages: user, ...body });
  expect(res.status).toBe(200);
  await res.text();
  return JSON.parse(upstreams.find(MESSAGES).at(-1)!.body) as Record<string, unknown>;
}
const pool = () => readPool(home!, "claude")! as { activeId?: string; accounts: { id: string; data: Record<string, unknown> }[] };
function setTokens(fields: Record<string, unknown>): void {
  const current = pool();
  writePool(home!, "claude", { ...current, accounts: current.accounts.map((a) => ({ ...a, data: { ...a.data, ...fields } })) });
}

describe("model envelope from live capabilities", () => {
  test("adaptive with high effort, and enabled-only without limits, both absent from the captured table", async () => {
    home = await makeHome();
    await login();
    const thinking = (enabled: boolean, adaptive: boolean) => ({ supported: true, types: { enabled: { supported: enabled }, adaptive: { supported: adaptive } } });
    upstreams.script("/v1/models", () =>
      jsonResponse({
        data: [
          { type: "model", id: "claude-live-adaptive", display_name: "Live Adaptive", created_at: "2026-10-01T00:00:00Z", max_input_tokens: 300_000, max_tokens: 64_000, capabilities: { thinking: thinking(false, true), effort: { supported: true, low: { supported: true }, high: { supported: true } } } },
          { type: "model", id: "claude-live-plain", display_name: "Live Plain", created_at: "2026-10-01T00:00:00Z", capabilities: { thinking: thinking(true, false), effort: { supported: true, low: { supported: true } } } },
        ],
        has_more: false,
      }),
    );
    const s = await serve();
    const adaptive = await sentFor(s, { model: "claude/claude-live-adaptive", thinking: { type: "adaptive" } });
    expect([adaptive["max_tokens"], adaptive["thinking"], adaptive["output_config"]]).toEqual([32_000, { type: "adaptive", display: "omitted" }, { effort: "high" }]);
    const plain = await sentFor(s, { model: "claude/claude-live-plain", thinking: { type: "enabled" } });
    expect([plain["max_tokens"], plain["thinking"], plain["output_config"]]).toEqual([32_000, { type: "enabled", budget_tokens: 31_999 }, undefined]);
  });
});

describe("request transform shapes", () => {
  test("thinking, output_config and system in every accepted shape", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    const opus = "claude/claude-opus-4-8";
    const sonnet = "claude/claude-sonnet-4-5";
    const thinkingOf = async (model: string, value: unknown) => (await sentFor(s, { model, max_tokens: 64, thinking: value }))["thinking"];
    expect(await thinkingOf(opus, { type: "adaptive", display: "summarized" })).toEqual({ type: "adaptive", display: "summarized" });
    expect(await thinkingOf(opus, { display: "summarized" })).toEqual({ type: "adaptive", display: "summarized" });
    expect(await thinkingOf(opus, "on")).toEqual({ type: "adaptive", display: "omitted" });
    expect(await thinkingOf(opus, { type: "weird" })).toEqual({ type: "adaptive", display: "omitted" });
    expect(await thinkingOf(opus, { type: "enabled", budget_tokens: "x" })).toEqual({ type: "enabled", budget_tokens: 31_999 });
    expect(await thinkingOf(sonnet, { type: "enabled", budgetTokens: 3000 })).toEqual({ type: "enabled", budget_tokens: 3000 });
    expect(await thinkingOf(sonnet, { type: "enabled" })).toEqual({ type: "enabled", budget_tokens: 31_999 });

    const effortOf = async (value: unknown) => (await sentFor(s, { model: opus, max_tokens: 64, output_config: value }))["output_config"];
    expect(await effortOf({ effort: "low" })).toEqual({ effort: "low" });
    expect(await effortOf({ effort: "" })).toEqual({ effort: "high" });
    expect(await effortOf({ effort: 5 })).toEqual({ effort: "high" });
    expect(await effortOf("x")).toEqual({ effort: "high" });

    const systemOf = async (value: unknown) => ((await sentFor(s, { model: opus, max_tokens: 64, system: value }))["system"] as unknown[]).slice(2);
    expect(await systemOf("be brief")).toEqual([{ type: "text", text: "be brief" }]);
    expect(await systemOf([{ type: "text", text: "as blocks" }])).toEqual([{ type: "text", text: "as blocks" }]);
  });

  test("tool turns without any id are dropped; a last user turn whose blocks are all plain is kept as is", async () => {
    home = await makeHome();
    await login();
    const s = await serve();
    const idless = await sentFor(s, {
      model: "claude/claude-opus-4-8",
      max_tokens: 64,
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }, { role: "tool", content: [{ type: "tool-result", result: "r" }] }, { role: "tool", content: "bare result" }, { role: "user", content: "go" }],
    });
    expect((idless["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const plain = await sentFor(s, { model: "claude/claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(plain["messages"]).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });
});

describe("accounts and upstream answers", () => {
  test("an account without an account uuid; an answer without a content type; a count_tokens answer without a body", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({}, ["account"]));
    await login();
    const s = await serve();
    const sent = await sentFor(s, { model: "claude/claude-opus-4-8", max_tokens: 64 });
    expect(JSON.parse((sent["metadata"] as { user_id: string }).user_id)["account_uuid"]).toBe("");
    const rawBody = new TextEncoder().encode('{"id":"msg_raw"}');
    upstreams.script(MESSAGES, () => new Response(new ReadableStream({ start: (c) => (c.enqueue(rawBody), c.close()) })));
    const raw = await post(s, MESSAGES, { model: "claude/claude-opus-4-8", max_tokens: 64, messages: user });
    expect([raw.status, await raw.text()]).toEqual([200, '{"id":"msg_raw"}']);
    upstreams.script("/v1/messages/count_tokens", () => new Response(null, { status: 204 }));
    const counted = await post(s, "/v1/messages/count_tokens", { model: "claude/claude-opus-4-8", messages: user });
    expect([counted.status, await counted.text()]).toEqual([204, ""]);
  });

  test("a token endpoint answering non-JSON fails the login", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", () => new Response("<html>oops</html>"));
    const failed = await run(["login", "claude", "--timeout-seconds", "30"]);
    expect([failed.code, failed.stderr]).toEqual([1, "error: claude upstream HTTP 502: token endpoint returned non-JSON: <html>oops</html>\n"]);
  });

  test("an unreadable catalog copy is logged and replaced; the live catalog stops after 10 pages", async () => {
    home = await makeHome();
    await login();
    setTokens({ organizationUuid: undefined });
    mkdirSync(join(home.dir, "state", "claude"), { recursive: true });
    writeFileSync(join(home.dir, "state", "claude", "model-catalog.json"), "{oops");
    const page = (n: number) => () => jsonResponse({ data: [{ type: "model", id: `claude-page-${n}`, display_name: `Page ${n}` }], has_more: true, last_id: `claude-page-${n}` });
    upstreams.script("/v1/models", ...Array.from({ length: 10 }, (_, n) => page(n)));
    const listed = await run(["models", "claude"]);
    expect(listed.stdout.split("\n")[0]).toBe("# claude: 10 models (live catalog)");
    expect(await loggedEventually(home!, "WARN claude: model list cache unreadable: StoreCorruptError")).toContain("WARN claude: model list cache unreadable: StoreCorruptError");
  });

  test("a catalog copy that cannot be written is logged; the live list is still used", async () => {
    home = await makeHome();
    await login();
    expect((await run(["models", "claude"])).code).toBe(0);
    const cache = join(home.dir, "state", "claude", "model-catalog.json");
    writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, "utf8")), fetchedAt: 0 }));
    chmodSync(join(home.dir, "state", "claude"), 0o500);
    const listed = await run(["models", "claude"]);
    chmodSync(join(home.dir, "state", "claude"), 0o700);
    expect(listed.stdout.split("\n")[0]).toMatch(/^# claude: \d+ models \(live catalog\)$/);
    expect(await loggedEventually(home!, "WARN claude: model list cache write failed: Error: EACCES")).toContain("WARN claude: model list cache write failed: Error: EACCES");
  });

  test("model_selector failure falls back to /v1/models in live catalog", async () => {
    home = await makeHome();
    await login();
    const page = () => jsonResponse({ data: [{ type: "model", id: "claude-fallback-1", display_name: "Fallback 1" }], has_more: false });
    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => new Response("error", { status: 500 }));
    upstreams.script("/v1/models", page);
    const listed = await run(["models", "claude"]);
    expect(listed.stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");
    expect(await loggedEventually(home!, "INFO claude: model_selector failed (model_selector HTTP 500), trying /v1/models")).toContain("INFO claude: model_selector failed (model_selector HTTP 500), trying /v1/models");
  });

  test("model_selector with empty or malformed entries parses valid entries and falls back if empty", async () => {
    home = await makeHome();
    await login();
    const config = {
      model_selector_config: [
        {
          id: "cc",
          models: [
            null,
            { id: "" },
            { id: "claude-custom-1", name: "Custom 1", runtime: { effort_levels: ["high"] }, capabilities: { mm_images: true, mm_pdf: true } },
            { id: "claude-custom-2", name: "Claude 2", runtime: { max_input_tokens: 500_000, max_output_tokens: 64_000 } },
            { id: "claude-custom-3" },
          ],
        },
      ],
    };
    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse(config));
    const listed = await run(["models", "claude"]);
    expect(listed.stdout.split("\n")[0]).toBe("# claude: 3 models (live catalog)");

    // Test non-array / empty configs falling back to /v1/models
    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse(null));
    upstreams.script("/v1/models", () => jsonResponse({ data: [{ type: "model", id: "claude-fb-null", display_name: "FBN" }], has_more: false }));
    const cache = join(home.dir, "state", "claude", "model-catalog.json");
    rmSync(cache);
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");

    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse("not-object"));
    upstreams.script("/v1/models", () => jsonResponse({ data: [{ type: "model", id: "claude-fb0", display_name: "FB0" }], has_more: false }));
    rmSync(cache);
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");

    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse({ model_selector_config: "not-array" }));
    upstreams.script("/v1/models", () => jsonResponse({ data: [{ type: "model", id: "claude-fb1", display_name: "FB1" }], has_more: false }));
    rmSync(cache);
    const listedFallback = await run(["models", "claude"]);
    expect(listedFallback.stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");

    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse({ model_selector_config: [null] }));
    upstreams.script("/v1/models", () => jsonResponse({ data: [{ type: "model", id: "claude-fb2", display_name: "FB2" }], has_more: false }));
    rmSync(cache);
    expect((await run(["models", "claude"])).stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");

    // And when models is empty, it falls back to /v1/models
    const emptyConfig = { model_selector_config: [{ id: "not-cc", models: "not-array" }] };
    upstreams.script("/api/organizations/e7ac4584-ce93-4714-9ffb-0553b2897eea/model_selector/cc", () => jsonResponse(emptyConfig));
    upstreams.script("/v1/models", () => jsonResponse({ data: [{ type: "model", id: "claude-fb", display_name: "FB" }], has_more: false }));
    rmSync(cache);
    const listed2 = await run(["models", "claude"]);
    expect(listed2.stdout.split("\n")[0]).toBe("# claude: 1 models (live catalog)");
  });

  test("a held refresh lock is waited for and the token rotated meanwhile is used", async () => {
    home = await makeHome();
    upstreams.script("/v1/oauth/token", claudeToken({ expires_in: 60 }));
    await login();
    const s = await serve();
    mkdirSync(join(home.dir, "locks"), { recursive: true });
    const lock = join(home.dir, "locks", "claude-refresh.lock");
    writeFileSync(lock, "4242 0\n");
    const before = upstreams.find("/v1/oauth/token").length;
    const waiting = post(s, MESSAGES, { model: "claude/claude-opus-4-8", max_tokens: 64, messages: user });
    await Bun.sleep(300);
    setTokens({ accessToken: "rotated-elsewhere", expiresAt: Date.now() + 3_600_000 });
    rmSync(lock);
    const answer = await waiting;
    await answer.text();
    expect([answer.status, upstreams.find(MESSAGES).at(-1)!.headers["authorization"], upstreams.find("/v1/oauth/token").length - before]).toEqual([200, "Bearer rotated-elsewhere", 0]);
  });
});
