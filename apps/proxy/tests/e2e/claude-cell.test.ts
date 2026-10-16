// The native Anthropic → claude cell, black-box: request checks, the never-prefill laws L1–L4 and tool-result
// normalization, thinking (F9/Q6), betas (F4), anthropic-version, the per-model envelope from the live catalog, and
// how upstream answers come back. Assertions read what the replay upstream really received.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { startSignedInDaemon, type SignedInDaemon } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { brokenStream, jsonResponse, ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

const upstreams = new ReplayUpstreams();
let env: SignedInDaemon;
beforeAll(async () => {
  upstreams.start();
  env = await startSignedInDaemon(upstreams.seamEnv());
});
afterAll(async () => {
  await env.daemon.stop();
  upstreams.stop();
  removeTemporary(env.home.dir);
});
afterEach(() => upstreams.reset());

const MESSAGES = "/v1/messages";
const HAIKU = "claude/claude-haiku-4-5-20251001";
type Answer = { status: number; body: Record<string, unknown>; text: string; headers: Headers };

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${env.daemon.url}/anthropic${path}`, {
    method: "POST",
    headers: { "x-api-key": env.token, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const messages = (body: Record<string, unknown>, headers?: Record<string, string>) => post(MESSAGES, { model: HAIKU, max_tokens: 64, ...body }, headers);
const sent = () => {
  const last = upstreams.find(MESSAGES).at(-1)!;
  return { headers: last.headers, body: JSON.parse(last.body) as Record<string, unknown> };
};
const error = (a: Answer) => a.body["error"] as { type: string; message: string };

describe("routing and request checks", () => {
  test("a path claude does not serve, a non-JSON body, a body without messages", async () => {
    const other = await post("/v1/complete", { model: HAIKU, prompt: "x" });
    expect([other.status, error(other).message]).toEqual([400, "claude has no native route /v1/complete"]);
    const notJson = await post(MESSAGES, "{oops");
    expect([notJson.status, error(notJson).message]).toEqual([400, "request body is not valid JSON"]);
    const noModel = await post(MESSAGES, { messages: [] });
    expect(error(noModel).message).toContain("needs a string model");
    const noMessages = await post(MESSAGES, { model: HAIKU });
    expect([noMessages.status, error(noMessages).message]).toEqual([400, "request body must be an object with a messages array"]);
  });

  test("anthropic-version other than the captured one: 400, or dropped and reported with lossy", async () => {
    const strict = await messages({ messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2024-01-01" });
    expect([strict.status, error(strict).type, error(strict).message]).toEqual([400, "invalid_request_error", "claude (the captured client speaks anthropic-version 2023-06-01) cannot carry: anthropic-version:2024-01-01"]);
    const lossy = await messages({ messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2024-01-01", "x-proxy-lossy": "1" });
    expect([lossy.status, lossy.headers.get("x-proxy-dropped")]).toEqual([200, "anthropic-version:2024-01-01"]);
    expect(sent().headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("anthropic-beta: captured names first, duplicates collapsed; unknown names refused or dropped", async () => {
    await messages({ messages: [{ role: "user", content: "hi" }] }, { "anthropic-beta": "oauth-2025-04-20, oauth-2025-04-20" });
    expect(sent().headers["anthropic-beta"]!.split(",")[0]).toBe("oauth-2025-04-20");
    const lossy = await messages({ messages: [{ role: "user", content: "hi" }] }, { "anthropic-beta": "files-api-2025-04-14,oauth-2025-04-20", "x-proxy-lossy": "1" });
    expect(lossy.headers.get("x-proxy-dropped")).toBe("anthropic-beta:files-api-2025-04-14");
    expect(sent().headers["anthropic-beta"]).not.toContain("files-api");
  });
});

describe("never-prefill laws and tool results (L1–L4)", () => {
  const toolUse = { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "toolu_1", name: "get_time", input: {} }] };

  test("trailing assistant and tool turns are stripped; an empty result becomes one empty user turn", async () => {
    await messages({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "prefill" }] });
    expect(sent().body["messages"]).toEqual([{ role: "user", content: "q" }]);
    await messages({ messages: [{ role: "assistant", content: "only" }] });
    expect(sent().body["messages"]).toEqual([{ role: "user", content: "" }]);
  });

  test("role:tool messages become user tool_result turns (block or bare form, error flag kept); orphans are dropped", async () => {
    await messages({
      messages: [
        { role: "user", content: "q" },
        toolUse,
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: { ok: true }, is_error: false }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_1", result: "r2", isError: true }] },
        { role: "tool", tool_use_id: "toolu_1", content: "bare" },
        { role: "tool", toolCallId: "toolu_1", content: "bare camel" },
        { role: "tool", tool_use_id: "toolu_unknown", content: "orphan" },
        { role: "tool", content: [{ type: "text", text: "no result block" }] },
        { role: "tool", content: 7 },
        { role: "user", content: "next" },
      ],
    });
    expect(sent().body["messages"]).toEqual([
      { role: "user", content: "q" },
      toolUse,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}', is_error: false }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r2", is_error: true }] },
      { role: "user", tool_use_id: "toolu_1", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "bare" }] },
      { role: "user", toolCallId: "toolu_1", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "bare camel" }] },
      { role: "user", content: "next" },
    ]);
  });

  test("dangling tool_result blocks in the last user turn are removed; assistant turns without blocks are kept", async () => {
    await messages({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "plain" },
        toolUse,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, { type: "tool_result", tool_use_id: "toolu_gone", content: "x" }, { type: "text", text: "and?" }] },
      ],
    });
    expect((sent().body["messages"] as unknown[]).at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, { type: "text", text: "and?" }] });
  });
});

describe("thinking (F9 / Q6) and the per-model envelope", () => {
  test("absent stays absent, disabled stays disabled, enabled keeps the clear-thinking edit; extra keys are stripped", async () => {
    await messages({ messages: [{ role: "user", content: "q" }] });
    expect("thinking" in sent().body || "context_management" in sent().body).toBe(false);
    await messages({ messages: [{ role: "user", content: "q" }], thinking: { type: "disabled" } });
    expect([sent().body["thinking"], "context_management" in sent().body]).toEqual([{ type: "disabled" }, false]);
    await messages({ max_tokens: 2048, messages: [{ role: "user", content: "q" }], thinking: { type: "enabled", budget_tokens: 1024, extra: 1 } });
    expect(sent().body["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(sent().body["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  });

  test("a model only in the live catalog gets its envelope from the catalog's capabilities", async () => {
    await post(MESSAGES, { model: "claude/claude-opus-5", max_tokens: 64, messages: [{ role: "user", content: "q" }], thinking: { type: "adaptive" } });
    expect(sent().body["model"]).toBe("claude-opus-5");
    expect(sent().body["thinking"]).toMatchObject({ type: "adaptive" });
  });

  test("the alias claude-haiku-4-5 uses the dated model's envelope", async () => {
    await post(MESSAGES, { model: "claude/claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: "q" }] });
    expect(sent().headers["anthropic-beta"]).toBe(upstreams.find(MESSAGES).at(0)!.headers["anthropic-beta"]);
  });
});

describe("upstream answers", () => {
  test("count_tokens passes through", async () => {
    const count = await post("/v1/messages/count_tokens", { model: HAIKU, messages: [{ role: "user", content: "hi" }] });
    expect([count.status, count.body]).toEqual([200, { input_tokens: 2095 }]);
  });

  test("an upstream error passes through with its status and body; a refusal stream is passed and logged", async () => {
    upstreams.script(MESSAGES, () => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529));
    const overloaded = await messages({ messages: [{ role: "user", content: "q" }] });
    expect([overloaded.status, error(overloaded).type]).toEqual([529, "overloaded_error"]);
    const refusal = ['event: message_start\ndata: {"type":"message_start","message":{"id":"msg_r"}}', "event: ping\ndata: not-json", 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}', ""].join("\n\n");
    upstreams.script(MESSAGES, () => new Response(refusal, { headers: { "content-type": "text/event-stream" } }));
    const answer = await messages({ messages: [{ role: "user", content: "q" }], stream: true });
    expect(answer.text).toBe(refusal);
  });

  test("a stream that breaks after the first byte ends the response without hanging", async () => {
    upstreams.script(MESSAGES, () => brokenStream('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_b"}}\n\n'));
    const answer = await messages({ messages: [{ role: "user", content: "q" }], stream: true });
    expect(answer.text).toStartWith("event: message_start");
  });
});
