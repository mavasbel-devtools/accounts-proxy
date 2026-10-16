import { describe, expect, test } from "bun:test";
import { QuotaExhaustedError, UnauthorizedError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { GeminiCodec } from "@accounts-proxy/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { describeCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelCatalog } from "@accounts-proxy/core/domain/models.ts";

const described = (catalogs: readonly ModelCatalog[]) => catalogs.map((c) => describeCatalog(c, undefined, undefined));

const codec = new GeminiCodec();

describe("GeminiCodec", () => {
  test("identity", () => {
    expect([codec.dialect, codec.prefix]).toEqual(["gemini", "/gemini"]);
  });

  test("Google error envelope; an upstream Google body verbatim; retry-after when known", () => {
    expect(codec.error(new UnauthorizedError())).toEqual({
      status: 401,
      headers: { "content-type": "application/json" },
      body: '{"error":{"code":401,"message":"missing or invalid accounts-proxy token","status":"UNAUTHENTICATED"}}',
    });
    const upstream = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';
    expect(codec.error(new UpstreamError("antigravity", 400, upstream)).body).toBe(upstream);
    const quota = codec.error(new QuotaExhaustedError("antigravity", "x", 12));
    expect(quota.headers["retry-after"]).toBe("12");
    expect(JSON.parse(quota.body).error.status).toBe("RESOURCE_EXHAUSTED");
  });

  test("models: name models/<provider>/<model>, limits when known, generation methods only for Gemini-native providers", () => {
    const encoded = codec.models(described([
      { provider: "antigravity", formats: ["gemini"], source: "live", models: [{ address: { provider: "antigravity", model: "g" }, displayName: "G", contextWindow: 80_000, maxOutputTokens: 65_536 }] },
      { provider: "claude", formats: ["anthropic-messages"], source: "static", models: [{ address: { provider: "claude", model: "c" }, displayName: "C" }] },
    ]));
    expect(encoded.status).toBe(200);
    expect(JSON.parse(encoded.body)).toEqual({
      models: [
        { name: "models/antigravity/g", baseModelId: "antigravity/g", version: "antigravity", displayName: "G", inputTokenLimit: 80_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
        { name: "models/claude/c", baseModelId: "claude/c", version: "claude", displayName: "C", supportedGenerationMethods: [] },
      ],
    });
  });
});
