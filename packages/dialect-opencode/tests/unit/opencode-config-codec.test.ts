// The opencode v2 configuration and well-known manifest (plan 2026-10-16 rules O1–O6), checked against opencode's
// published configuration schema (docs/reference/specs/opencode-config-schema.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DetailedCatalog, DetailedModel } from "@inference-router/core/domain/model-details.ts";
import { OpencodeConfigCodec, opencodeProviderId, PROVIDER_NAMES } from "@inference-router/dialect-opencode/adapters/inbound/opencode-config-codec.ts";
import { validate } from "@inference-router/test-support/json-schema.ts";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "opencode-config-schema.json"), "utf8")) as Record<string, unknown>;
const AT = { origin: "http://127.0.0.1:4141", tokenCommand: ["/usr/bin/bun", "/app/cli.ts", "token"] };
const codec = new OpencodeConfigCodec();

const model = (provider: DetailedModel["provider"], id: string, over: Partial<DetailedModel> = {}): DetailedModel => ({ id: `${provider}/${id}`, provider, model: id, name: id, formats: [], sources: {}, ...over });
const catalog = (provider: DetailedCatalog["provider"], models: DetailedModel[], over: Partial<DetailedCatalog> = {}): DetailedCatalog => ({ provider, source: "live", models, ...over });

describe("OpencodeConfigCodec.config", () => {
  test("one ir-<provider> per catalog; each model on the route of its format with its limits, media, price and variants", () => {
    const doc = codec.config(
      [
        catalog("claude", [
          model("claude", "claude-opus-6", {
            name: "Claude Opus 6",
            family: "claude-opus",
            formats: ["anthropic-messages"],
            aiSdkPackage: "@ai-sdk/anthropic",
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
            input: ["text", "image", "pdf"],
            output: ["text"],
            toolCall: true,
            reasoningOptions: [{ type: "effort", values: ["low", "high"] }],
          }),
        ]),
        catalog("openrouter", [
          model("openrouter", "vendor/m", { formats: ["openai-chat", "openai-responses", "anthropic-messages"], aiSdkPackage: "@openrouter/ai-sdk-provider", inputLimit: 900, interleavedField: "reasoning_details", cost: [{ input: 1, output: 2, cacheRead: 0.1 }, { input: 3, output: 4, cacheWrite: 5, tier: { type: "context", size: 200_000 } }, { input: 0, output: 0 }] }),
        ]),
        catalog("opencode", [
          model("opencode", "chat", { formats: ["openai-chat"], aiSdkPackage: "@ai-sdk/openai-compatible", reasoningOptions: [{ type: "effort", values: ["high"] }] }),
          model("opencode", "named-but-elsewhere", { formats: ["gemini"], aiSdkPackage: "@ai-sdk/anthropic" }),
          model("opencode", "unknown-format", { aiSdkPackage: "@ai-sdk/unknown" }),
        ]),
        catalog("antigravity", [model("antigravity", "gemini-x", { formats: ["gemini"], reasoningOptions: [{ type: "effort", values: ["low"] }] })]),
        catalog("openai", [model("openai", "gpt-x", { formats: ["openai-responses"], reasoningOptions: [{ type: "effort", values: ["low"] }] })]),
        catalog("cheaper-inference", [], { source: "unavailable", error: { code: "provider_auth_required", message: "x" } }),
      ],
      AT,
    );
    expect(validate(schema, doc)).toEqual([]);
    const providers = doc["providers"] as Record<string, { name: string; settings: object; headers?: object; models: Record<string, Record<string, unknown>> }>;
    expect(Object.keys(providers)).toEqual(["ir-claude", "ir-openrouter", "ir-opencode", "ir-antigravity", "ir-openai"]);
    expect(providers["ir-claude"]!.name).toBe("Inference Router · Claude");
    expect(providers["ir-claude"]!.settings).toEqual({ apiKey: "{env:INFERENCE_ROUTER_TOKEN}" });
    expect(providers["ir-claude"]!.models["claude-opus-6"]).toEqual({
      modelID: "claude/claude-opus-6",
      name: "Claude Opus 6",
      family: "claude-opus",
      package: "@opencode/ai/providers/anthropic",
      settings: { baseURL: "http://127.0.0.1:4141/anthropic/v1" },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      limit: { context: 1_000_000, output: 128_000 },
      // Rule O6 (live C6): the thinking-prefix controls and per-message effort updates the claude cell refuses.
      compatibility: { supportsThinkingBlockBinding: false, supportsEffortUpdates: false },
      variants: [
        { id: "low", settings: { effort: "low", thinking: { type: "adaptive", display: "summarized" } } },
        { id: "high", settings: { effort: "high", thinking: { type: "adaptive", display: "summarized" } } },
      ],
    });
    expect(providers["ir-openrouter"]!.models["vendor/m"]).toEqual({
      modelID: "openrouter/vendor/m",
      name: "vendor/m",
      package: "@opencode/ai/providers/openrouter",
      settings: { baseURL: "http://127.0.0.1:4141/openai/v1" },
      limit: { input: 900 },
      cost: [{ input: 1, output: 2, cache: { read: 0.1 } }, { tier: { type: "context", size: 200_000 }, input: 3, output: 4, cache: { write: 5 } }, { input: 0, output: 0 }],
      compatibility: { reasoningField: "reasoning_details" },
      variants: [],
    });
    const opencode = providers["ir-opencode"]!.models;
    expect(Object.keys(opencode)).toEqual(["chat", "named-but-elsewhere"]);
    expect([opencode["chat"]!["package"], opencode["chat"]!["settings"], opencode["chat"]!["variants"]]).toEqual(["@opencode/ai/providers/openai-compatible", { baseURL: "http://127.0.0.1:4141/openai/v1", provider: "ir-opencode" }, [{ id: "high", settings: { reasoningEffort: "high" } }]]);
    expect([opencode["named-but-elsewhere"]!["package"], opencode["named-but-elsewhere"]!["settings"]]).toEqual(["@opencode/ai/providers/google", { baseURL: "http://127.0.0.1:4141/gemini/v1beta" }]);
    // Plugin law 1: the Antigravity thinking budget is the catalog's, so no variant.
    expect(providers["ir-antigravity"]!.models["gemini-x"]!["variants"]).toEqual([]);
    expect(providers["ir-openai"]!.headers).toEqual({ "x-router-lossy": "1" });
    expect(providers["ir-openai"]!.models["gpt-x"]!["compatibility"]).toEqual({ supportsEffortUpdates: false });
    expect(opencode["chat"]!["compatibility"]).toBeUndefined();
    expect((providers["ir-openai"]!.models["gpt-x"]!["variants"] as { id: string }[]).map((v) => v.id)).toEqual(["low"]);
    expect(doc["$schema"]).toBe("https://opencode.ai/config.json");
  });

  test("the schema check catches a wrong document; names and ids", () => {
    expect(validate(schema, { providers: { x: { models: { m: { limit: { context: "1" }, nope: 1 } } } } })).toEqual(["$.providers.x.models.m.limit.context: expected integer, got string", "$.providers.x.models.m.nope: not allowed"]);
    expect(opencodeProviderId("opencode-go")).toBe("ir-opencode-go");
    expect(Object.keys(PROVIDER_NAMES)).toHaveLength(7);
  });
});

describe("OpencodeConfigCodec.manifest", () => {
  test("the token command and the configuration URL with the token substituted (wellknown.ts)", () => {
    expect(codec.manifest(AT)).toEqual({
      auth: { command: ["/usr/bin/bun", "/app/cli.ts", "token"], env: "INFERENCE_ROUTER_TOKEN" },
      remote_config: { url: "http://127.0.0.1:4141/opencode/config.json", headers: { authorization: "Bearer {env:INFERENCE_ROUTER_TOKEN}" } },
    });
  });
});
