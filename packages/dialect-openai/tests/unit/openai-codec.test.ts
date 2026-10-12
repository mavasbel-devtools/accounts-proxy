import { describe, expect, test } from "bun:test";
import { QuotaExhaustedError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { OpenAiCodec, unixSeconds } from "@inference-router/dialect-openai/adapters/inbound/openai-codec.ts";

const codec = new OpenAiCodec();

describe("OpenAiCodec", () => {
  test("identity", () => {
    expect([codec.dialect, codec.prefix]).toEqual(["openai", "/openai"]);
  });

  test("ErrorResponse with all four required fields; retry-after when known", () => {
    const encoded = codec.error(new UnsupportedFeatureError(["chat_completions"], "openai"));
    expect(encoded.status).toBe(400);
    expect(encoded.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(encoded.body)).toEqual({ error: { message: "openai cannot carry: chat_completions", type: "unsupported_feature", param: null, code: "unsupported_feature" } });
    expect(codec.error(new QuotaExhaustedError("antigravity", "x", 5)).headers["retry-after"]).toBe("5");
  });

  test("models: list of Model objects owned by the provider; created in Unix seconds or 0", () => {
    const encoded = codec.models([
      { provider: "claude", formats: ["anthropic-messages"], source: "cache", models: [{ address: { provider: "claude", model: "c" }, displayName: "C", createdAt: "2026-07-24T00:00:00Z" }] },
      { provider: "antigravity", formats: ["gemini"], source: "live", models: [{ address: { provider: "antigravity", model: "g" }, displayName: "G" }] },
    ]);
    expect(JSON.parse(encoded.body)).toEqual({
      object: "list",
      data: [
        { id: "claude/c", object: "model", created: 1_784_851_200, owned_by: "claude" },
        { id: "antigravity/g", object: "model", created: 0, owned_by: "antigravity" },
      ],
    });
    expect(unixSeconds("not a date")).toBe(0);
  });
});
