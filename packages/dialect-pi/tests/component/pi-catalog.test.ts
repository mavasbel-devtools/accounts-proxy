// The whole pinned reference catalog through PiConfigCodec (plan 2026-11-15-23-52 rule P1): every routed model
// carries its own api and baseUrl, thinking maps stay within pi's values, and every cost has the four rates.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AISDK_FORMAT } from "@accounts-proxy/core/domain/client-connection.ts";
import { parseReference, REFERENCE_PROVIDER, type DetailedCatalog, type DetailedModel } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { PI_API, PiConfigCodec } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-config-codec.ts";
import type { PiApi } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-thinking.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";

const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "pi-models-schema.json"), "utf8")) as Record<string, unknown>;
const reference = parseReference(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "models-opencode-reference.json"), "utf8")));
const AT = { origin: "http://127.0.0.1:4141", tokenCommand: ["/usr/bin/bun", "/app/cli.ts", "token"] };
const codec = new PiConfigCodec();

/** One DetailedCatalog per proxy provider with a reference provider, formats as the provider packages assign. */
function catalogs(): DetailedCatalog[] {
  const out: DetailedCatalog[] = [];
  for (const provider of Object.keys(REFERENCE_PROVIDER) as ProviderId[]) {
    const refProvider = REFERENCE_PROVIDER[provider];
    if (refProvider === undefined) continue;
    const entries = reference.get(refProvider);
    if (entries === undefined) continue;
    const models: DetailedModel[] = [];
    for (const [modelId, ref] of entries) {
      const formats =
        provider === "claude"
          ? (["anthropic-messages"] as const)
          : provider === "antigravity"
            ? (["gemini"] as const)
            : provider === "openai"
              ? (["openai-responses"] as const)
              : ref.aiSdkPackage !== undefined && AISDK_FORMAT[ref.aiSdkPackage] !== undefined
                ? [AISDK_FORMAT[ref.aiSdkPackage]!]
                : [];
      models.push({
        id: `${provider}/${modelId}`,
        provider,
        model: modelId,
        name: ref.name ?? modelId,
        formats: [...formats],
        ...(ref.contextWindow !== undefined ? { contextWindow: ref.contextWindow } : {}),
        ...(ref.maxOutputTokens !== undefined ? { maxOutputTokens: ref.maxOutputTokens } : {}),
        ...(ref.input !== undefined ? { input: ref.input } : {}),
        ...(ref.reasoning !== undefined ? { reasoning: ref.reasoning } : {}),
        ...(ref.reasoningOptions !== undefined ? { reasoningOptions: ref.reasoningOptions } : {}),
        ...(ref.aiSdkPackage !== undefined ? { aiSdkPackage: ref.aiSdkPackage } : {}),
        ...(ref.cost !== undefined ? { cost: ref.cost } : {}),
        sources: {},
      } satisfies DetailedModel);
    }
    out.push({ provider, source: "live", models });
  }
  return out;
}

const counts = catalogs();
const modelCount = counts.reduce((sum, c) => sum + c.models.length, 0);
const byId = (models: { id: string; [k: string]: unknown }[], id: string): { [k: string]: unknown } | undefined => models.find((m) => m["id"] === id);

describe("PiConfigCodec over the reference catalog", () => {
  test(`the whole reference catalog validates; every routed model on its own api with pi's thinking values and full costs (${modelCount} models) [feature=pi-inference use-case=uc-pi-5 tier=component polarity=positive]`, () => {
    expect(modelCount).toBeGreaterThan(0);
    const doc = codec.config(counts, AT);
    expect(validate(schema, doc)).toEqual([]);
    const providers = doc["providers"] as Record<string, { models: { id: string; [k: string]: unknown }[] }>;
    for (const catalog of counts) {
      const docModels = providers[`ap-${catalog.provider}`]!.models;
      for (const model of catalog.models) {
        const entry = byId(docModels, model.id);
        if (model.formats.length === 0) {
          expect(entry).toBeUndefined();
          continue;
        }
        expect(entry).toBeDefined();
        const apis = model.formats.map((f) => PI_API[f].api);
        expect(apis).toContain(entry!["api"] as PiApi);
        expect(entry!["baseUrl"]).toBe(`http://127.0.0.1:4141${Object.values(PI_API).find((r) => r.api === entry!["api"])!.path}`);
        const map = entry!["thinkingLevelMap"] as Record<string, string | null> | undefined;
        if (map !== undefined) {
          for (const value of Object.values(map)) expect(value === null || typeof value === "string").toBe(true);
          if (entry!["api"] === "google-generative-ai") {
            expect(map["xhigh"]).toBeNull();
            expect(map["max"]).toBeNull();
          }
        }
        const cost = entry!["cost"] as { input: unknown; output: unknown; cacheRead: unknown; cacheWrite: unknown } | undefined;
        if (cost !== undefined) {
          for (const rate of [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]) expect(typeof rate).toBe("number");
        }
      }
    }
    expect(Object.keys(providers)).toHaveLength(counts.length);
  });

  test("a catalog whose models all lack formats yields an empty models list that still validates, and a format-less model is absent (0 routed of 2) [feature=pi-inference use-case=uc-pi-5 tier=component polarity=negative]", () => {
    const empty: DetailedCatalog = {
      provider: "openrouter",
      source: "live",
      models: [
        { id: "openrouter/a", provider: "openrouter", model: "a", name: "a", formats: [], sources: {} },
        { id: "openrouter/b", provider: "openrouter", model: "b", name: "b", formats: [], aiSdkPackage: "@ai-sdk/unknown", sources: {} },
      ],
    };
    const doc = codec.config([empty], AT);
    expect(validate(schema, doc)).toEqual([]);
    expect((doc["providers"] as Record<string, { models: unknown[] }>)["ap-openrouter"]!.models).toEqual([]);
  });
});
