// The pi models.json configuration and well-known manifest (plan 2026-11-15-23-52 rules P1–P7), checked against
// pi 1.5.2's published configuration schema (docs/reference/specs/pi-models-schema.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_DISPLAY_NAMES } from "@accounts-proxy/core/domain/client-connection.ts";
import type { DetailedCatalog, DetailedModel } from "@accounts-proxy/core/domain/model-details.ts";
import { gatewayCompat, PI_API, PI_CONFIG_PATH, PI_SCHEMA_URL, PiConfigCodec, piProviderId, SUBSCRIPTION_COMPAT, TOKEN_VARIABLE } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-config-codec.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "pi-models-schema.json"), "utf8")) as Record<string, unknown>;
const AT = { origin: "http://127.0.0.1:4141", tokenCommand: ["/usr/bin/bun", "/app/cli.ts", "token"] };
const codec = new PiConfigCodec();

const model = (provider: DetailedModel["provider"], id: string, over: Partial<DetailedModel> = {}): DetailedModel => ({ id: `${provider}/${id}`, provider, model: id, name: id, formats: [], sources: {}, ...over });
const catalog = (provider: DetailedCatalog["provider"], models: DetailedModel[], over: Partial<DetailedCatalog> = {}): DetailedCatalog => ({ provider, source: "live", models, ...over });

const claudeModels = [
  model("claude", "claude-opus-5-5", {
    name: "Claude Opus 5.5",
    formats: ["anthropic-messages"],
    aiSdkPackage: "@ai-sdk/anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    input: ["text", "image", "pdf"],
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }, { type: "budget_tokens", min: 1024 }],
    cost: [{ input: 5, output: 25, cacheRead: 0.5 }],
  }),
  model("claude", "no-formats", { formats: [] }),
];
const openrouterModels = [
  model("openrouter", "anthropic/claude-fable-5.2", { formats: ["openai-chat", "openai-responses", "anthropic-messages"], aiSdkPackage: "@openrouter/ai-sdk-provider" }),
  model("openrouter", "openai/gpt-6.1-terra-pro", { formats: ["openai-chat", "openai-responses", "anthropic-messages"], aiSdkPackage: "@openrouter/ai-sdk-provider" }),
  model("openrouter", "inclusionai/ling-3.2-flash:free", {
    formats: ["openai-chat", "openai-responses", "anthropic-messages"],
    aiSdkPackage: "@openrouter/ai-sdk-provider",
    cost: [{ input: 0, output: 0 }],
  }),
  model("openrouter", "anthropic/msgs-only", { formats: ["anthropic-messages"], aiSdkPackage: "@ai-sdk/anthropic" }),
  model("openrouter", "openai/resp-only", { formats: ["openai-responses"], aiSdkPackage: "@ai-sdk/openai" }),
  model("openrouter", "qwen/qwen3.7-flash", {
    formats: ["openai-chat"],
    aiSdkPackage: "@openrouter/ai-sdk-provider",
    cost: [
      { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
      { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.125, tier: { type: "context", size: 32000 } },
      { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25, tier: { type: "context", size: 256000 } },
    ],
  }),
  model("openrouter", "gemini-only", { formats: ["gemini"], aiSdkPackage: "@openrouter/ai-sdk-provider" }),
];
const openaiModels = [
  model("openai", "gpt-5.6-sol", {
    formats: ["openai-responses"],
    aiSdkPackage: "@ai-sdk/openai",
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  }),
  model("openai", "plain", { formats: ["openai-responses"], reasoning: false }),
];
const antigravityModels = [
  model("antigravity", "gemini-3.5-flash-lite", {
    formats: ["gemini"],
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  }),
];
const opencodeModels = [
  model("opencode", "cat-jam-free", { formats: ["openai-chat"], aiSdkPackage: "@ai-sdk/openai-compatible" }),
  model("opencode", "gemini-3.5-flash-lite", {
    formats: ["gemini"],
    aiSdkPackage: "@ai-sdk/google",
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  }),
];
const opencodeGoModels = [model("opencode-go", "go-chat", { formats: ["openai-chat"], aiSdkPackage: "@ai-sdk/openai-compatible" })];
const cheaperModels = [model("cheaper-inference", "ampersand-v0.1", { formats: ["openai-chat", "openai-responses", "anthropic-messages"], input: ["pdf"] })];

const all = () => codec.config([catalog("claude", claudeModels), catalog("openrouter", openrouterModels), catalog("openai", openaiModels), catalog("antigravity", antigravityModels), catalog("opencode", opencodeModels), catalog("opencode-go", opencodeGoModels), catalog("cheaper-inference", cheaperModels)], AT);
const providersOf = (doc: ReturnType<typeof all>): Record<string, { name: string; settings?: unknown; headers?: unknown; apiKey: string; models: { id: string; [k: string]: unknown }[] }> =>
  doc["providers"] as Record<string, { name: string; settings?: unknown; headers?: unknown; apiKey: string; models: { id: string; [k: string]: unknown }[] }>;
const byId = (models: { id: string; [k: string]: unknown }[], id: string): { [k: string]: unknown } => models.find((m) => m["id"] === id)!;

describe("PiConfigCodec.config", () => {
  test("one ap-<provider> per available catalog in order, named, with the token variable and no provider api [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    const doc = all();
    expect(validate(schema, doc)).toEqual([]);
    const providers = providersOf(doc);
    expect(Object.keys(providers)).toEqual(["ap-claude", "ap-openrouter", "ap-openai", "ap-antigravity", "ap-opencode", "ap-opencode-go", "ap-cheaper-inference"]);
    for (const [id, provider] of Object.entries(providers)) {
      expect(provider.name).toBe(`AP · ${PROVIDER_DISPLAY_NAMES[id.slice("ap-".length) as keyof typeof PROVIDER_DISPLAY_NAMES]}`);
      expect(provider.apiKey).toBe("$ACCOUNTS_PROXY_TOKEN");
      expect(provider).not.toHaveProperty("api");
      expect(provider).not.toHaveProperty("baseUrl");
    }
    expect(providers["ap-claude"]!.name).toBe("AP · Claude");
    expect(doc["$schema"]).toBe("https://pi.dev/schemas/models.schema.json");
    expect(PI_CONFIG_PATH).toBe("/pi/models.json");
    expect(PI_SCHEMA_URL).toBe("https://pi.dev/schemas/models.schema.json");
    expect(TOKEN_VARIABLE).toBe("ACCOUNTS_PROXY_TOKEN");
  });

  test("an unavailable catalog is left out and the remainder still validates [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const doc = codec.config([catalog("claude", claudeModels), catalog("cheaper-inference", [], { source: "unavailable", error: { code: "provider_auth_required", message: "x" } })], AT);
    expect(validate(schema, doc)).toEqual([]);
    expect(Object.keys(providersOf(doc))).toEqual(["ap-claude"]);
  });

  test("a document with a model missing id fails the schema check [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const errors = validate(schema, { $schema: PI_SCHEMA_URL, providers: { "ap-claude": { name: "AP · Claude", apiKey: "$ACCOUNTS_PROXY_TOKEN", models: [{}] } } });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("id"))).toBe(true);
  });

  test("the openai provider carries no headers [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const doc = all();
    for (const provider of Object.values(providersOf(doc))) expect(provider).not.toHaveProperty("headers");
  });

  test("P3 fields: limits, media, a 3-entry tiered cost and a cost without cache rates [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    const models = providersOf(all())["ap-openrouter"]!.models;
    expect(byId(models, "openrouter/qwen/qwen3.7-flash")["cost"]).toEqual({
      input: 0.03,
      output: 0.13,
      cacheRead: 0.006,
      cacheWrite: 0.038,
      tiers: [
        { inputTokensAbove: 32000, input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.125 },
        { inputTokensAbove: 256000, input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 },
      ],
    });
    expect(byId(models, "openrouter/inclusionai/ling-3.2-flash:free")["cost"]).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const opus = byId(providersOf(all())["ap-claude"]!.models, "claude/claude-opus-5-5");
    expect(opus).toMatchObject({
      id: "claude/claude-opus-5-5",
      name: "Claude Opus 5.5",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:4141/anthropic",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
    });
    const amp = byId(providersOf(all())["ap-cheaper-inference"]!.models, "cheaper-inference/ampersand-v0.1");
    expect(amp).not.toHaveProperty("input");
    expect(amp).not.toHaveProperty("contextWindow");
    expect(amp).not.toHaveProperty("maxTokens");
    expect(amp).not.toHaveProperty("cost");
  });
});

describe("pi routes (P2)", () => {
  test("every format rides its proxy route [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=positive]", () => {
    const p = providersOf(all());
    expect([byId(p["ap-claude"]!.models, "claude/claude-opus-5-5")["api"], byId(p["ap-claude"]!.models, "claude/claude-opus-5-5")["baseUrl"]]).toEqual(["anthropic-messages", "http://127.0.0.1:4141/anthropic"]);
    expect([byId(p["ap-openrouter"]!.models, "openrouter/anthropic/claude-fable-5.2")["api"], byId(p["ap-openrouter"]!.models, "openrouter/anthropic/claude-fable-5.2")["baseUrl"]]).toEqual([
      "openai-completions",
      "http://127.0.0.1:4141/openai/v1",
    ]);
    expect([byId(p["ap-openai"]!.models, "openai/gpt-5.6-sol")["api"], byId(p["ap-openai"]!.models, "openai/gpt-5.6-sol")["baseUrl"]]).toEqual(["openai-responses", "http://127.0.0.1:4141/openai/v1"]);
    expect([byId(p["ap-antigravity"]!.models, "antigravity/gemini-3.5-flash-lite")["api"], byId(p["ap-antigravity"]!.models, "antigravity/gemini-3.5-flash-lite")["baseUrl"]]).toEqual([
      "google-generative-ai",
      "http://127.0.0.1:4141/gemini/v1beta",
    ]);
    expect(PI_API).toEqual({
      "anthropic-messages": { api: "anthropic-messages", path: "/anthropic" },
      "openai-chat": { api: "openai-completions", path: "/openai/v1" },
      "openai-responses": { api: "openai-responses", path: "/openai/v1" },
      gemini: { api: "google-generative-ai", path: "/gemini/v1beta" },
    });
    expect(piProviderId("opencode-go")).toBe("ap-opencode-go");
  });

  test("a model without a chosen format is left out [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=negative]", () => {
    const models = providersOf(all())["ap-claude"]!.models;
    expect(models.some((m) => m["id"] === "claude/no-formats")).toBe(false);
    expect(models.map((m) => m["id"])).toEqual(["claude/claude-opus-5-5"]);
  });
});

describe("subscription compat (P5)", () => {
  test("claude, openai and antigravity rows [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=positive]", () => {
    const p = providersOf(all());
    expect(SUBSCRIPTION_COMPAT["claude"]).toEqual({ supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, supportsMessageThreads: false });
    expect(SUBSCRIPTION_COMPAT["openai"]).toEqual({ supportsMaxOutputTokens: false, supportsMidConvoEffort: false });
    expect(byId(p["ap-claude"]!.models, "claude/claude-opus-5-5")["compat"]).toEqual({
      forceAdaptiveThinking: true,
      supportsMidConvoEffort: false,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
      supportsMessageThreads: false,
    });
    expect(byId(p["ap-openai"]!.models, "openai/gpt-5.6-sol")).toMatchObject({ reasoning: true, compat: { supportsMaxOutputTokens: false, supportsMidConvoEffort: false } });
    expect(byId(p["ap-openai"]!.models, "openai/gpt-5.6-sol")["thinkingLevelMap"]).toMatchObject({ off: "none" });
    expect(byId(p["ap-openai"]!.models, "openai/plain")).toMatchObject({ reasoning: true, compat: { supportsMaxOutputTokens: false, supportsMidConvoEffort: false } });
  });

  test("an antigravity effort model reasons false with no map and no compat [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=negative]", () => {
    expect(byId(providersOf(all())["ap-antigravity"]!.models, "antigravity/gemini-3.5-flash-lite")).toEqual({
      id: "antigravity/gemini-3.5-flash-lite",
      name: "gemini-3.5-flash-lite",
      api: "google-generative-ai",
      baseUrl: "http://127.0.0.1:4141/gemini/v1beta",
      reasoning: false,
    });
  });
});

describe("gateway compat (P6)", () => {
  test("every gateway row [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=positive]", () => {
    const p = providersOf(all());
    expect(byId(p["ap-openrouter"]!.models, "openrouter/anthropic/claude-fable-5.2")["compat"]).toEqual({
      thinkingFormat: "openrouter",
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
      cacheControlFormat: "anthropic",
    });
    expect(byId(p["ap-openrouter"]!.models, "openrouter/openai/gpt-6.1-terra-pro")["compat"]).toEqual({
      thinkingFormat: "openrouter",
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
    expect(byId(p["ap-openrouter"]!.models, "openrouter/inclusionai/ling-3.2-flash:free")["compat"]).toEqual({
      thinkingFormat: "openrouter",
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
      supportsDeveloperRole: false,
    });
    expect(byId(p["ap-openrouter"]!.models, "openrouter/anthropic/msgs-only")["compat"]).toEqual({ sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" });
    expect(byId(p["ap-openrouter"]!.models, "openrouter/openai/resp-only")["compat"]).toEqual({ sessionAffinityFormat: "openrouter" });
    expect(byId(p["ap-opencode"]!.models, "opencode/cat-jam-free")["compat"]).toEqual({ supportsStore: false, supportsDeveloperRole: false });
    expect(byId(p["ap-opencode-go"]!.models, "opencode-go/go-chat")["compat"]).toEqual({ supportsStore: false, supportsDeveloperRole: false });
  });

  test("cheaper-inference gets none and an openrouter gemini route gets none [feature=pi-inference use-case=uc-pi-5 tier=unit polarity=negative]", () => {
    const p = providersOf(all());
    expect(byId(p["ap-cheaper-inference"]!.models, "cheaper-inference/ampersand-v0.1")).not.toHaveProperty("compat");
    expect(gatewayCompat(model("openrouter", "gemini-only", { formats: ["gemini"] }), "google-generative-ai")).toBeUndefined();
    expect(gatewayCompat(model("claude", "x", { formats: ["anthropic-messages"] }), "anthropic-messages")).toBeUndefined();
  });
});

describe("PiConfigCodec.manifest", () => {
  test("the token command and the models document URL [feature=pi-config use-case=uc-pi-3 tier=unit polarity=positive]", () => {
    expect(codec.manifest(AT)).toEqual({
      auth: { command: ["/usr/bin/bun", "/app/cli.ts", "token"], env: "ACCOUNTS_PROXY_TOKEN" },
      config: { url: "http://127.0.0.1:4141/pi/models.json" },
    });
  });
});
