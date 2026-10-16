// P3 parity gate: for the same input, the proxy's outbound Claude request (url, headers, body bytes) must equal
// the reference implementation's (opencode-claude-auth @ 6292741, tests/reference/plugin-6292741). Any difference
// is a defect, except the deliberate fixes listed (and asserted) at the bottom of this file. F9 (Q6) changes every
// request whose thinking is absent or disabled, so `both` applies exactly that change to the reference output before
// the byte comparison; the F9 tests below assert the reference really differs there.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capturedBetaHeader, transformRequest, type TransformContext, type WireRequestBody } from "@accounts-proxy/provider-claude/domain/request-transform.ts";
import type { CatalogModelEntry } from "@accounts-proxy/provider-claude/domain/model-envelope.ts";
// Loaded through a computed specifier so the typecheck does not compile the verbatim (differently linted) source.
type ReferenceService = new (
  random: { uuid(): string; sha256Base64Url(input: string): string },
  apiBase: string,
  modelEntry: (id: string) => CatalogModelEntry | undefined,
) => {
  transform(
    input: { headers: Record<string, string>; body: never; path: string },
    ctx: { accessToken: string; accountUuid: string; deviceId: string; sessionId: string; previousMessageId: string | null },
  ): { headers: Record<string, string>; url: string; body: string };
};
const referencePath = join(import.meta.dir, "..", "reference", "plugin-6292741", "domain", "services", "RequestTransformService.ts");
const { RequestTransformService } = (await import(referencePath)) as { RequestTransformService: ReferenceService };

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-6292741");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
const captured = json<WireRequestBody>("messages-single-request.json");
const catalogEnvelopes = json<Record<string, unknown>>("model-catalog-envelopes.json");

const BASE = {
  accessToken: "sk-ant-oat01-parity",
  accountUuid: "00000000-0000-4000-8000-000000000000",
  deviceId: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  sessionId: "7196556b-af5a-44b8-8f2b-af706ae4feb2",
};

const futureEntry: CatalogModelEntry = {
  id: "claude-future-9",
  displayName: "Future",
  createdAt: "",
  maxInputTokens: 500_000,
  maxTokens: 100_000,
  capabilities: {
    thinking: { supported: true, types: { enabled: false, adaptive: true } },
    effort: { supported: true, levels: ["low", "high"] },
    batch: true,
    citations: true,
    codeExecution: true,
    imageInput: true,
    pdfInput: true,
    structuredOutputs: true,
    contextManagement: { clearToolUses: true, clearThinking: true, compact: true },
  },
};
const lookup = (id: string) => (id === futureEntry.id ? futureEntry : undefined);

/** F9 (user decision Q6): the reference body without the default thinking (when absent) and the clear-thinking edit. */
function withF9(referenceBody: string, client: WireRequestBody): string {
  const t = client.thinking;
  const absent = t === undefined;
  const disabled = t !== null && typeof t === "object" && (t as { type?: unknown }).type === "disabled";
  if (!absent && !disabled) return referenceBody;
  const parsed = JSON.parse(referenceBody) as Record<string, unknown>;
  if (absent) delete parsed["thinking"];
  delete parsed["context_management"];
  return JSON.stringify(parsed);
}

function reference(body: WireRequestBody, path: string, previousMessageId: string | null, apiBase: string) {
  let n = 0;
  const service = new RequestTransformService({ uuid: () => `uuid-${++n}`, sha256Base64Url: () => "unused" }, apiBase, lookup);
  return service.transform({ headers: {}, body: body as never, path }, { ...BASE, previousMessageId });
}

function both(body: WireRequestBody, path = "/v1/messages", previousMessageId: string | null = null, apiBase = "https://api.anthropic.com") {
  const source = reference(body, path, previousMessageId, apiBase);
  const expected = { ...source, body: withF9(source.body, body) };
  const ctx: TransformContext = { ...BASE, previousMessageId, ccPromptId: "uuid-1", clientRequestId: "uuid-2" };
  const actual = transformRequest({ body, path, betaHeader: capturedBetaHeader(body.model, lookup) }, ctx, lookup, apiBase);
  return { expected, actual };
}

const user = [{ role: "user", content: "hi" }];
const cases: [string, WireRequestBody][] = [
  ["captured opus-4-8 wire as input", captured],
  ["captured wire, system as a string", { ...captured, system: "be brief" }],
  ["no system", { model: "claude-haiku-4-5-20251001", messages: user }],
  ["unknown model, no catalog entry", { model: "claude-unknown-1", messages: user }],
  ["unknown model with live catalog entry", { model: "claude-future-9", messages: user }],
  ["undated haiku alias", { model: "claude-haiku-4-5", messages: user }],
  ["explicit max_tokens wins", { model: "claude-opus-4-8", max_tokens: 1234, messages: user }],
  ["host adaptive thinking with display", { model: "claude-opus-5", thinking: { type: "adaptive", display: "summarized" }, messages: user }],
  ["host adaptive thinking with extra keys (block_binding stripped)", { model: "claude-opus-5", thinking: { type: "adaptive", adaptive: { block_binding: true } }, messages: user }],
  ["enabled thinking, integer budget >= 1024", { model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 4096 }, messages: user }],
  ["enabled thinking, camelCase budget", { model: "claude-sonnet-4-5", thinking: { type: "enabled", budgetTokens: 2048 }, messages: user }],
  ["enabled thinking, no budget (fallback)", { model: "claude-opus-4-5-20251101", thinking: { type: "enabled" }, messages: user }],
  ["enabled thinking, non-numeric budget", { model: "claude-opus-4-8", thinking: { type: "enabled", budget_tokens: "x" }, messages: user }],
  ["enabled thinking on a model whose fallback is adaptive", { model: "claude-opus-4-8", thinking: { type: "enabled" }, messages: user }],
  ["disabled thinking", { model: "claude-opus-4-8", thinking: { type: "disabled" }, messages: user }],
  ["unknown thinking type", { model: "claude-opus-4-8", thinking: { type: "weird" }, messages: user }],
  ["thinking without a type", { model: "claude-opus-4-8", thinking: { display: "x" }, messages: user }],
  ["thinking not an object", { model: "claude-opus-4-8", thinking: "on", messages: user }],
  ["host effort wins", { model: "claude-opus-4-7", output_config: { effort: "low" }, messages: user }],
  ["empty host effort falls back", { model: "claude-opus-4-7", output_config: { effort: "" }, messages: user }],
  ["no effort on a no-effort model", { model: "claude-haiku-4-5-20251001", output_config: {}, messages: user }],
  ["sampling + unknown keys pass through", { model: "claude-opus-4-8", temperature: 0.3, top_p: 0.9, top_k: 7, stop_sequences: ["X"], future_key: { a: 1 }, messages: user }],
  ["L1 trailing assistant", { model: "claude-opus-4-8", messages: [...user, { role: "assistant", content: "prefill" }] }],
  [
    "L2 tool role with matching tool_use (object result, isError)",
    {
      model: "claude-opus-4-8",
      messages: [
        ...user,
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", result: { ok: 1 }, isError: true }] },
        { role: "user", content: "go on" },
      ],
    },
  ],
  [
    "L2 bare-string tool message, and unknown id dropped",
    {
      model: "claude-opus-4-8",
      messages: [
        ...user,
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] },
        { role: "tool", content: "raw", tool_use_id: "t2" },
        { role: "tool", content: "orphan", toolCallId: "nope" },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "t2" }] },
        { role: "tool" },
        { role: "user", content: "next" },
      ],
    },
  ],
  [
    "L3 dangling tool_result in the final user message",
    {
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }, { type: "text", text: "hi" }] },
      ],
    },
  ],
  ["L1 all-invalid history becomes one empty user turn", { model: "claude-opus-4-8", messages: [{ role: "assistant", content: "a" }] }],
  ["trailing system roster is kept", { model: "claude-opus-4-8", messages: [...user, { role: "system", content: "roster" }] }],
  ...Object.keys(catalogEnvelopes).map((model): [string, WireRequestBody] => [`captured envelope ${model}`, { model, stream: true, messages: user }]),
];

describe("parity with opencode-claude-auth @ 6292741 (url, headers, body bytes)", () => {
  for (const [name, body] of cases) {
    test(name, () => {
      const { expected, actual } = both(body);
      expect(actual.url).toBe(expected.url);
      expect(actual.headers).toEqual(expected.headers);
      expect(actual.body).toBe(expected.body);
    });
  }

  test.each([["/v1/messages/count_tokens"]])("path %p", (path) => {
    const { expected, actual } = both(captured, path);
    expect(actual).toEqual(expected);
  });

  test("previous_message_id and a custom api base", () => {
    const { expected, actual } = both(captured, "/v1/messages", "msg_chain_7", "http://127.0.0.1:9");
    expect(actual).toEqual(expected);
  });
});

describe("deliberate differences (each one asserted, nothing else may differ)", () => {
  const thinkingOf = (body: string) => (JSON.parse(body) as { thinking: unknown }).thinking;
  const withoutThinking = (body: string) => {
    const { thinking: _t, ...rest } = JSON.parse(body) as Record<string, unknown>;
    return rest;
  };

  test("F3: an explicit budget below 1024 is passed through, not clamped (source AGENTS.md §8)", () => {
    const { expected, actual } = both({ model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 512 }, messages: user });
    expect(thinkingOf(expected.body)).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(thinkingOf(actual.body)).toEqual({ type: "enabled", budget_tokens: 512 });
    expect(withoutThinking(actual.body)).toEqual(withoutThinking(expected.body));
    expect(actual.headers).toEqual(expected.headers);
  });

  test("F3: a fractional budget is passed through, not floored", () => {
    const { expected, actual } = both({ model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 2048.5 }, messages: user });
    expect(thinkingOf(expected.body)).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(thinkingOf(actual.body)).toEqual({ type: "enabled", budget_tokens: 2048.5 });
    expect(withoutThinking(actual.body)).toEqual(withoutThinking(expected.body));
  });

  test("F9: absent thinking — the reference adds the captured default thinking and the clear-thinking edit; the proxy adds neither", () => {
    const body: WireRequestBody = { model: "claude-haiku-4-5-20251001", messages: user };
    const source = JSON.parse(reference(body, "/v1/messages", null, "https://api.anthropic.com").body) as Record<string, unknown>;
    expect(source["thinking"]).toEqual({ type: "enabled", display: "omitted", budget_tokens: 31999 });
    expect(source["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
    const actual = JSON.parse(both(body).actual.body) as Record<string, unknown>;
    expect("thinking" in actual).toBe(false);
    expect("context_management" in actual).toBe(false);
  });

  test("F9: disabled thinking — kept, without the clear-thinking edit (the upstream 400s on that pair)", () => {
    const body: WireRequestBody = { model: "claude-opus-4-8", thinking: { type: "disabled" }, messages: user };
    const source = JSON.parse(reference(body, "/v1/messages", null, "https://api.anthropic.com").body) as Record<string, unknown>;
    expect(source["context_management"]).toBeDefined();
    const actual = JSON.parse(both(body).actual.body) as Record<string, unknown>;
    expect(actual["thinking"]).toEqual({ type: "disabled" });
    expect("context_management" in actual).toBe(false);
  });

  test("F9: enabled or adaptive thinking keeps the captured clear-thinking edit", () => {
    for (const thinking of [{ type: "enabled", budget_tokens: 2048 }, { type: "adaptive" }, { type: "weird" }]) {
      const actual = JSON.parse(both({ model: "claude-opus-4-8", thinking, messages: user }).actual.body) as Record<string, unknown>;
      expect(actual["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
    }
  });
});
