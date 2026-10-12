import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GO_BUILTIN, ZEN_BUILTIN } from "@inference-router/provider-opencode/domain/builtin-models.ts";
import { checkKeyFormat, GO_SPEC, modelsDevEntries, opencodeModels, ZEN_SPEC } from "@inference-router/provider-opencode/domain/opencode.ts";

const spec = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", file), "utf8"));

describe("OpenCode Zen and Go rules", () => {
  test("Z1–Z3, Z9: bases, endpoints and the key header per endpoint; Go has no Gemini route", () => {
    expect([ZEN_SPEC.apiBase, GO_SPEC.apiBase]).toEqual(["https://opencode.ai/zen/v1", "https://opencode.ai/zen/go/v1"]);
    expect(ZEN_SPEC.endpoints["anthropic-messages"]).toEqual({ path: "/messages", keyHeader: "x-api-key" });
    expect(ZEN_SPEC.endpoints.gemini).toEqual({ path: "/models", keyHeader: "x-goog-api-key" });
    expect(ZEN_SPEC.endpoints["openai-chat"]!.keyHeader).toBe("authorization");
    expect(GO_SPEC.endpoints.gemini).toBeUndefined();
    expect([ZEN_SPEC.requestIdHeader, GO_SPEC.requestIdHeader, ZEN_SPEC.uniformFormats]).toEqual(["x-opencode-log-id", "x-opencode-log-id", undefined]);
  });

  test("Z4 + Z5: the committed lists and models.dev give the built-in lists", () => {
    const md = spec("models-dev-gateways.json");
    const zen = opencodeModels(spec("opencode-zen-models.json"), modelsDevEntries(md, "opencode"));
    const go = opencodeModels(spec("opencode-go-models.json"), modelsDevEntries(md, "opencode-go"));
    expect(zen).toEqual([...ZEN_BUILTIN]);
    expect(go).toEqual([...GO_BUILTIN]);
    expect(zen.find((m) => m.id === "big-pickle")).toEqual({ id: "big-pickle", displayName: "Big Pickle", contextWindow: 200_000, maxOutputTokens: 32_000, formats: ["openai-chat"] });
    // zen.mdx: Claude models on /messages, GPT on /responses, Gemini on /models/<id>, Mistral on /chat/completions.
    const format = (id: string) => zen.find((m) => m.id === id)?.formats;
    expect([format("claude-haiku-4-5"), format("gpt-5.5"), format("gemini-3.6-flash"), format("mistral-large-4")]).toEqual([["anthropic-messages"], ["openai-responses"], ["gemini"], ["openai-chat"]]);
    // Z6: a live id that models.dev does not describe keeps no formats.
    expect(zen.find((m) => m.id === "jev-1.13")).toEqual({ id: "jev-1.13", displayName: "jev-1.13" });
  });

  test("modelsDevEntries: provider npm fallback, unknown packages, malformed entries", () => {
    const md = {
      opencode: {
        npm: "@ai-sdk/openai-compatible",
        models: { a: { name: "A", limit: { context: 10, output: 5 } }, b: { provider: { npm: "@ai-sdk/unknown" }, limit: "x" }, c: 3 },
      },
      "opencode-go": { models: { d: { provider: { npm: 7 } } } },
    };
    const none = { name: undefined, context: undefined, output: undefined, format: undefined };
    expect([...modelsDevEntries(md, "opencode")]).toEqual([
      ["a", { name: "A", context: 10, output: 5, format: "openai-chat" }],
      ["b", none],
      ["c", { ...none, format: "openai-chat" }],
    ]);
    expect([...modelsDevEntries(md, "opencode-go")]).toEqual([["d", none]]);
    expect(modelsDevEntries({ opencode: { models: [] } }, "opencode").size).toBe(0);
    expect(modelsDevEntries(null, "opencode").size).toBe(0);
    expect(opencodeModels({ data: [{ id: "x" }, { object: "model" }, "y"] }, new Map())).toEqual([{ id: "x", displayName: "x" }]);
    expect(opencodeModels(null, new Map())).toEqual([]);
  });

  test("Z7: Console keys start oc_sk_, legacy keys sk-", () => {
    expect(() => checkKeyFormat("oc_sk_1")).not.toThrow();
    expect(() => checkKeyFormat("sk-1")).not.toThrow();
    expect(() => checkKeyFormat("ci_live_1")).toThrow("an OpenCode API key starts with oc_sk_ (or sk- for a legacy key)");
  });
});
