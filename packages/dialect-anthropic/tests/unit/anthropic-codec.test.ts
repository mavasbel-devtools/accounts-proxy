import { describe, expect, test } from "bun:test";
import { InvalidRequestError, QuotaExhaustedError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import type { ModelCatalog } from "@inference-router/core/domain/models.ts";
import { AnthropicCodec, anthropicErrorType, UNDATED } from "@inference-router/dialect-anthropic/adapters/inbound/anthropic-codec.ts";

const codec = new AnthropicCodec();

describe("AnthropicCodec", () => {
  test("identity", () => {
    expect([codec.dialect, codec.prefix]).toEqual(["anthropic", "/anthropic"]);
  });

  test("error envelope and documented types; retry-after when known", () => {
    expect(codec.error(new InvalidRequestError("bad"))).toEqual({
      status: 400,
      headers: { "content-type": "application/json" },
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
    });
    const quota = codec.error(new QuotaExhaustedError("claude", "x", 30));
    expect(quota.headers["retry-after"]).toBe("30");
    expect(JSON.parse(quota.body).error.type).toBe("rate_limit_error");
    expect(JSON.parse(codec.error(new UpstreamError("claude", 502, "x")).body).error.type).toBe("api_error");
  });

  test.each([
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [409, "conflict_error"],
    [413, "request_too_large"],
    [502, "api_error"],
    [500, "api_error"],
    [503, "api_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ])("status %p → %p", (status, type) => {
    expect(anthropicErrorType(status)).toBe(type);
  });

  test("models: every catalog, routable ids, dates or the neutral marker, limits or null", () => {
    const catalogs: ModelCatalog[] = [
      { provider: "claude", nativeDialect: "anthropic", source: "live", models: [{ address: { provider: "claude", model: "claude-opus-5" }, displayName: "Opus", contextWindow: 1000, maxOutputTokens: 10, createdAt: "2026-07-24T00:00:00Z" }] },
      { provider: "antigravity", nativeDialect: "gemini", source: "live", models: [{ address: { provider: "antigravity", model: "g" }, displayName: "G" }] },
    ];
    const encoded = codec.models(catalogs);
    expect(encoded.status).toBe(200);
    expect(JSON.parse(encoded.body)).toEqual({
      data: [
        { type: "model", id: "claude/claude-opus-5", display_name: "Opus", created_at: "2026-07-24T00:00:00Z", max_input_tokens: 1000, max_tokens: 10, capabilities: null, line: null },
        { type: "model", id: "antigravity/g", display_name: "G", created_at: UNDATED, max_input_tokens: null, max_tokens: null, capabilities: null, line: null },
      ],
      first_id: "claude/claude-opus-5",
      has_more: false,
      last_id: "antigravity/g",
    });
    expect(JSON.parse(codec.models([]).body)).toEqual({ data: [], first_id: null, has_more: false, last_id: null });
  });
});
