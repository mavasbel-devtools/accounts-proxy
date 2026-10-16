// The detailed model record (plan 2026-10-16 C2, rules M1–M5) and the reference catalog reader.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compactDetails,
  describeCatalog,
  modalities,
  parseReference,
  perMillion,
  reasoningOptions,
  REFERENCE_PROVIDERS,
  referenceCatalog,
  referenceRecord,
  withDetails,
  type ReferenceCatalog,
  type ReferenceModel,
} from "@inference-router/core/domain/model-details.ts";
import type { ModelCatalog } from "@inference-router/core/domain/models.ts";

const reference: ReferenceCatalog = new Map<string, ReadonlyMap<string, ReferenceModel>>([
  ["anthropic", new Map([["c", { name: "Claude C", contextWindow: 200_000, maxOutputTokens: 64_000, toolCall: true, cost: [{ input: 1, output: 5 }] }]])],
  ["openrouter", new Map([["vendor/m", { name: "Ref M", family: "fam", cost: [{ input: 9, output: 9 }] }]])],
]);

describe("describeCatalog (M1–M3, M5)", () => {
  test("the provider's own fields first, the reference fills the rest, each with its source; no price on a subscription provider", () => {
    const claude: ModelCatalog = {
      provider: "claude",
      formats: ["anthropic-messages"],
      source: "live",
      models: [
        { address: { provider: "claude", model: "c" }, displayName: "c", maxOutputTokens: 32_000, createdAt: "2026-01-01T00:00:00Z", details: { structuredOutput: true } },
        { address: { provider: "claude", model: "unknown" }, displayName: "Unknown" },
      ],
    };
    expect(describeCatalog(claude, reference, "cache")).toEqual({
      provider: "claude",
      source: "live",
      referenceSource: "cache",
      models: [
        {
          id: "claude/c",
          provider: "claude",
          model: "c",
          name: "Claude C",
          formats: ["anthropic-messages"],
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          createdAt: "2026-01-01T00:00:00Z",
          structuredOutput: true,
          toolCall: true,
          sources: {
            name: "models.opencode.ai:anthropic/c",
            contextWindow: "models.opencode.ai:anthropic/c",
            maxOutputTokens: "provider:claude",
            createdAt: "provider:claude",
            structuredOutput: "provider:claude",
            toolCall: "models.opencode.ai:anthropic/c",
          },
        },
        { id: "claude/unknown", provider: "claude", model: "unknown", name: "Unknown", formats: ["anthropic-messages"], sources: { name: "provider:claude" } },
      ],
    });
  });

  test("a gateway keeps the vendor's price and per-model formats; an unavailable provider keeps its error; no reference provider, no reference source", () => {
    const openrouter: ModelCatalog = { provider: "openrouter", formats: ["openai-chat"], source: "static", models: [{ address: { provider: "openrouter", model: "vendor/m" }, displayName: "Own M", details: { cost: [{ input: 1, output: 2 }] } }] };
    const [m] = describeCatalog(openrouter, reference, "live").models;
    expect([m!.name, m!.family, m!.cost, m!.sources.cost, m!.sources.family]).toEqual(["Own M", "fam", [{ input: 1, output: 2 }], "provider:openrouter", "models.opencode.ai:openrouter/vendor/m"]);
    const cheaper: ModelCatalog = { provider: "cheaper-inference", formats: [], source: "live", models: [{ address: { provider: "cheaper-inference", model: "x" }, displayName: "x", formats: ["openai-chat"] }] };
    expect(describeCatalog(cheaper, reference, "live")).toEqual({ provider: "cheaper-inference", source: "live", models: [{ id: "cheaper-inference/x", provider: "cheaper-inference", model: "x", name: "x", formats: ["openai-chat"], sources: {} }] });
    const down: ModelCatalog = { provider: "antigravity", formats: [], source: "unavailable", models: [], error: { code: "provider_auth_required", message: "no account" } };
    expect(describeCatalog(down, undefined, undefined)).toEqual({ provider: "antigravity", source: "unavailable", error: { code: "provider_auth_required", message: "no account" }, models: [] });
  });
});

describe("parseReference (models.dev format)", () => {
  test("the committed extract: the six reference providers, the fields opencode reads", () => {
    const parsed = parseReference(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "models-opencode-reference.json"), "utf8")));
    expect([...parsed.keys()]).toEqual([...REFERENCE_PROVIDERS]);
    expect(parsed.get("anthropic")!.get("claude-haiku-4-5")).toEqual({
      name: "Claude Haiku 4.5 (latest)",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      description: "Fast Claude lane for lightweight agents, office tasks, and responsive chat",
      family: "claude-haiku",
      releaseDate: "2025-10-15",
      knowledge: "2025-02-28",
      input: ["text", "image", "pdf"],
      output: ["text"],
      toolCall: true,
      structuredOutput: true,
      temperature: true,
      reasoning: true,
      reasoningOptions: [{ type: "budget_tokens", min: 1024 }],
      openWeights: false,
      aiSdkPackage: "@ai-sdk/anthropic",
      cost: [{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
    });
    expect(referenceCatalog(referenceRecord(parsed))).toEqual(parsed);
  });

  test("status, interleaved field, per-model package, tiers; malformed entries read as absent; unknown providers ignored", () => {
    const parsed = parseReference({
      other: { models: { z: {} } },
      openai: {
        npm: "@ai-sdk/openai",
        models: {
          a: { status: "beta", interleaved: "reasoning_content", provider: { npm: "@ai-sdk/anthropic" }, cost: { input: 1, output: 2, tiers: [{ input: 3, output: 4, tier: { type: "context", size: 10 } }, { input: 5, output: 6, tier: { type: "other", size: 1 } }, { input: 5, tier: { type: "context", size: 2 } }, { input: 1, output: 1, tier: { type: "context", size: 0 } }, 7, { tier: 1 }] } },
          b: { status: "active", interleaved: { field: "reasoning_details" }, limit: { context: 0, output: 1.5, input: 3 } },
          c: { interleaved: true, cost: { input: 1 }, limit: 7, modalities: { input: "text", output: [] } },
          d: 5,
        },
      },
      google: { models: [] },
      anthropic: "x",
    });
    expect([...parsed.keys()]).toEqual(["openai"]);
    const openai = parsed.get("openai")!;
    expect(openai.get("a")).toEqual({ status: "beta", interleavedField: "reasoning_content", aiSdkPackage: "@ai-sdk/anthropic", cost: [{ input: 1, output: 2 }, { input: 3, output: 4, tier: { type: "context", size: 10 } }] });
    expect(openai.get("b")).toEqual({ interleavedField: "reasoning_details", inputLimit: 3, aiSdkPackage: "@ai-sdk/openai" });
    expect(openai.get("c")).toEqual({ aiSdkPackage: "@ai-sdk/openai" });
    expect(openai.has("d")).toBe(false);
    expect(parseReference(null).size).toBe(0);
  });

  test("modalities and reasoning options", () => {
    expect([modalities(["pdf", "text", "x"]), modalities([]), modalities("text")]).toEqual([["text", "pdf"], undefined, undefined]);
    expect(
      reasoningOptions([{ type: "toggle" }, { type: "effort", values: ["low", null, "null", "", 3, "high"] }, { type: "budget_tokens", min: 0, max: 100 }, { type: "budget_tokens", min: -1, max: 0 }, { type: "effort", values: "x" }, { type: "?" }, null]),
    ).toEqual([{ type: "toggle" }, { type: "effort", values: ["low", "high"] }, { type: "budget_tokens", min: 0, max: 100 }, { type: "budget_tokens" }]);
    expect([reasoningOptions([]), reasoningOptions("x")]).toEqual([undefined, undefined]);
  });
});

describe("helpers", () => {
  test("perMillion: per-token or per-million decimal strings and numbers, 12 significant digits; anything else absent", () => {
    expect([perMillion("0.00000005", "token"), perMillion(0.000003, "token"), perMillion("1.650000", "million"), perMillion(" ", "million"), perMillion("-1", "million"), perMillion(null, "token"), perMillion("x", "token")]).toEqual([0.05, 3, 1.65, undefined, undefined, undefined, undefined]);
  });

  test("compactDetails keeps the stated fields only; withDetails spreads only stated details", () => {
    const none = { description: undefined, family: undefined, releaseDate: undefined, knowledge: undefined, status: undefined, inputLimit: undefined, input: undefined, output: undefined, toolCall: undefined, structuredOutput: undefined, temperature: undefined, reasoning: undefined, reasoningOptions: undefined, interleavedField: undefined, openWeights: undefined, aiSdkPackage: undefined, cost: undefined };
    expect(compactDetails(none)).toBeUndefined();
    expect(compactDetails({ ...none, toolCall: false })).toEqual({ toolCall: false });
    expect([withDetails(undefined), withDetails({ reasoning: true })]).toEqual([{}, { details: { reasoning: true } }]);
  });
});
