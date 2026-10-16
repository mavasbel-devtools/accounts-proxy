import { describe, expect, test } from "bun:test";
import { InvalidRequestError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import type { RawRequest } from "@inference-router/core/domain/wire.ts";
import {
  conversationId,
  asArray,
  asObject,
  fieldsText,
  firstString,
  forwardedResponseHeaders,
  gatewayModel,
  isCatalogSnapshot,
  keyHeaders,
  positiveInteger,
  rowsWithId,
  servedFormats,
  upstreamCall,
  type GatewaySpec,
} from "@inference-router/provider-gateway/domain/gateway.ts";

const SPEC: GatewaySpec = {
  provider: "opencode",
  apiBase: "https://gw/v1",
  endpoints: {
    "openai-chat": { path: "/chat/completions" },
    "anthropic-messages": { path: "/messages" },
    gemini: { path: "/models" },
  },
  requestIdHeader: "x-log-id",
};

const raw = (fields: Partial<RawRequest> & Pick<RawRequest, "format" | "path">): RawRequest => ({ query: {}, headers: {}, body: '{"model":"opencode/m","messages":[]}', lossy: false, ...fields });

describe("upstreamCall (rules G1, G2, G4)", () => {
  test("Chat: the vendor endpoint, the bare model id, only content-type and the client's accept", () => {
    const call = upstreamCall(SPEC, "m", raw({ format: "openai-chat", path: "/v1/chat/completions", headers: { accept: "text/event-stream", "x-other": "1", authorization: "Bearer router" } }));
    expect(call).toEqual({
      url: "https://gw/v1/chat/completions",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: '{"model":"m","messages":[]}',
    });
  });

  test("Messages: the Anthropic version and beta headers travel; count_tokens only where the vendor has it", () => {
    const call = upstreamCall(SPEC, "m", raw({ format: "anthropic-messages", path: "/v1/messages", headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "b1" } }));
    expect([call.url, call.headers]).toEqual(["https://gw/v1/messages", { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "b1" }]);
    expect(() => upstreamCall(SPEC, "m", raw({ format: "anthropic-messages", path: "/v1/messages/count_tokens" }))).toThrow("opencode cannot carry: count_tokens");
    const counting = { ...SPEC, countTokens: { path: "/messages/count_tokens" } };
    expect(upstreamCall(counting, "m", raw({ format: "anthropic-messages", path: "/v1/messages/count_tokens" })).url).toBe("https://gw/v1/messages/count_tokens");
    expect(() => upstreamCall(SPEC, "m", raw({ format: "anthropic-messages", path: "/v1/batches" }))).toThrow(InvalidRequestError);
  });

  test("Gemini: the model and method in the path, alt kept, the body unchanged; other methods are refused", () => {
    const body = '{"contents":[]}';
    const call = upstreamCall(SPEC, "gemini-3.6-flash", raw({ format: "gemini", path: "/v1beta/models/opencode%2Fgemini-3.6-flash:streamGenerateContent", query: { alt: "sse" }, body }));
    expect([call.url, call.body]).toEqual(["https://gw/v1/models/gemini-3.6-flash:streamGenerateContent?alt=sse", body]);
    expect(upstreamCall(SPEC, "g", raw({ format: "gemini", path: "/v1beta/models/opencode/g:generateContent", body })).url).toBe("https://gw/v1/models/g:generateContent");
    expect(() => upstreamCall(SPEC, "g", raw({ format: "gemini", path: "/v1beta/models/opencode/g:countTokens", body }))).toThrow("opencode cannot carry: countTokens");
  });

  test("a vendor's own headers are sent; the client headers it names travel when present (Z15)", () => {
    const own = { ...SPEC, headers: { "user-agent": "inference-router/0.1.0" }, forwardHeaders: ["x-opencode-session"] };
    expect(upstreamCall(own, "m", raw({ format: "openai-chat", path: "/v1/chat/completions", headers: { "x-opencode-session": "ses_1", "user-agent": "client/1" } })).headers).toEqual({ "user-agent": "inference-router/0.1.0", "content-type": "application/json", "x-opencode-session": "ses_1" });
    expect(upstreamCall(own, "m", raw({ format: "openai-chat", path: "/v1/chat/completions" })).headers).toEqual({ "user-agent": "inference-router/0.1.0", "content-type": "application/json" });
  });

  test("Z24: the session header is the client's, else the conversation's own id, else a hash of the first user turn", () => {
    const own = { ...SPEC, forwardHeaders: ["x-opencode-session"], sessionHeader: "x-opencode-session" };
    const chat = (headers: Record<string, string>, body: unknown) => upstreamCall(own, "m", raw({ format: "openai-chat", path: "/v1/chat/completions", headers, body: JSON.stringify(body) })).headers["x-opencode-session"];
    const first = { model: "opencode/m", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] };
    const later = { ...first, messages: [...first.messages, { role: "assistant", content: "yo" }, { role: "user", content: "again" }] };
    expect(chat({ "x-opencode-session": "ses_client" }, first)).toBe("ses_client");
    expect(chat({}, first)).toMatch(/^rtr_[0-9a-f]{16}$/);
    expect(chat({}, later)).toBe(chat({}, first)!);
    expect(chat({}, { ...first, messages: [{ role: "user", content: "other" }] })).not.toBe(chat({}, first)!);
    expect(chat({}, { model: "opencode/m", messages: [] })).toBeUndefined();
    expect(upstreamCall(SPEC, "m", raw({ format: "openai-chat", path: "/v1/chat/completions" })).headers["x-opencode-session"]).toBeUndefined();
  });

  test("Z24: conversationId per format", () => {
    const claudeCode = JSON.stringify({ metadata: { user_id: "user_ab12_account__session_0fae6fcb-7a48-4def-941f-6e06af96c972" }, messages: [{ role: "user", content: "x" }] });
    expect(conversationId("anthropic-messages", claudeCode)).toBe("0fae6fcb-7a48-4def-941f-6e06af96c972");
    expect(conversationId("anthropic-messages", JSON.stringify({ metadata: { user_id: "u" }, messages: [{ role: "user", content: "x" }] }))).toMatch(/^rtr_/);
    expect(conversationId("anthropic-messages", JSON.stringify({ metadata: 1, messages: "x" }))).toBeUndefined();
    expect(conversationId("openai-responses", JSON.stringify({ prompt_cache_key: "ses_aff", input: "x" }))).toBe("ses_aff");
    expect(conversationId("openai-responses", JSON.stringify({ prompt_cache_key: "", input: "x" }))).toBe(conversationId("openai-responses", JSON.stringify({ input: "x" }))!);
    const items = [{ type: "function_call_output", call_id: "c", output: "o" }, { role: "user", content: "x" }];
    expect(conversationId("openai-responses", JSON.stringify({ input: items }))).toBe(conversationId("openai-responses", JSON.stringify({ input: [items[1]] }))!);
    expect(conversationId("openai-responses", JSON.stringify({ input: 1 }))).toBeUndefined();
    expect(conversationId("gemini", JSON.stringify({ contents: [{ parts: [{ text: "x" }] }] }))).toMatch(/^rtr_[0-9a-f]{16}$/);
    expect(conversationId("gemini", JSON.stringify({}))).toBeUndefined();
    expect(conversationId("openai-chat", "[1]")).toBeUndefined();
    expect(conversationId("openai-chat", "{")).toBeUndefined();
  });

  test("a format without a vendor endpoint is a translated cell", () => {
    expect(() => upstreamCall(SPEC, "m", raw({ format: "openai-responses", path: "/v1/responses" }))).toThrow(UnsupportedFeatureError);
    expect(() => upstreamCall(SPEC, "m", raw({ format: "openai-responses", path: "/v1/responses" }))).toThrow("opencode (no native endpoint for this format; the router does not translate between formats) cannot carry: openai-responses_format");
  });
});

describe("headers and formats", () => {
  test("keyHeaders: the key as a bearer token (R1, C1, Z14)", () => {
    expect(keyHeaders("k")).toEqual({ authorization: "Bearer k" });
  });

  test("forwardedResponseHeaders keeps content-type, retry-after and the vendor's request id (G3)", () => {
    expect(forwardedResponseHeaders(SPEC, { "Content-Type": "text/event-stream", "retry-after": "3", "X-Log-Id": "abc", "set-cookie": "x" })).toEqual({ "content-type": "text/event-stream", "retry-after": "3", "x-log-id": "abc" });
  });

  test("servedFormats keeps the formats the spec has an endpoint for", () => {
    expect(servedFormats(SPEC, ["openai-responses", "gemini", "openai-chat"])).toEqual(["gemini", "openai-chat"]);
  });
});

describe("catalog helpers", () => {
  test("isCatalogSnapshot", () => {
    const model = { id: "m", displayName: "M", formats: ["openai-chat"] };
    expect(isCatalogSnapshot({ version: 1, fetchedAt: 1, models: [model, { id: "n", displayName: "N" }] })).toBe(true);
    expect(isCatalogSnapshot({ version: 1, fetchedAt: 1, models: [] })).toBe(true);
    for (const bad of [
      null,
      { version: 2, fetchedAt: 1, models: [model] },
      { version: 1, fetchedAt: "1", models: [model] },
      { version: 1, fetchedAt: 1, models: "x" },
      { version: 1, fetchedAt: 1, models: [{ id: 1, displayName: "M" }] },
      { version: 1, fetchedAt: 1, models: [{ id: "m", displayName: 1 }] },
      { version: 1, fetchedAt: 1, models: ["m"] },
      { version: 1, fetchedAt: 1, models: [{ id: "m", displayName: "M", formats: "openai-chat" }] },
      { version: 1, fetchedAt: 1, models: [{ id: "m", displayName: "M", formats: ["smoke-signals"] }] },
      { version: 1, fetchedAt: 1, models: [{ id: "m", displayName: "M", formats: [1] }] },
    ]) {
      expect(isCatalogSnapshot(bad)).toBe(false);
    }
  });

  test("positiveInteger and gatewayModel (Unix seconds become RFC 3339)", () => {
    expect([positiveInteger(5), positiveInteger(0), positiveInteger(1.5), positiveInteger("5")]).toEqual([5, undefined, undefined, undefined]);
    const bare = { id: "m", displayName: "M", contextWindow: undefined, maxOutputTokens: undefined, createdSeconds: undefined, formats: undefined };
    expect(gatewayModel(bare)).toEqual({ id: "m", displayName: "M" });
    expect(gatewayModel({ ...bare, contextWindow: 1, maxOutputTokens: 2, createdSeconds: 1_791_807_945, formats: ["gemini"] })).toEqual({ id: "m", displayName: "M", contextWindow: 1, maxOutputTokens: 2, createdAt: "2026-10-12T12:25:45.000Z", formats: ["gemini"] });
  });

  test("vendor JSON readers: a field of the wrong type reads as absent", () => {
    expect([asObject({ a: 1 }), asObject([1]), asObject(null)]).toEqual([{ a: 1 }, {}, {}]);
    expect([asArray([1]), asArray({})]).toEqual([[1], []]);
    expect([firstString(undefined, "", 3, "x", "y"), firstString(1)]).toEqual(["x", undefined]);
    expect(rowsWithId([{ id: "a" }, { id: 1 }, "b", null])).toEqual([{ id: "a" }]);
    expect(rowsWithId(undefined)).toEqual([]);
    expect(fieldsText("T:", { b: 1.5, a: "x", c: null }, ["a", "b", "c", "d"])).toBe('T:\n  a: "x"\n  b: 1.5\n  c: null');
  });
});
