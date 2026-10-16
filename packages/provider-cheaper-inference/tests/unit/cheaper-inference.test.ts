import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHEAPER_BUILTIN } from "@accounts-proxy/provider-cheaper-inference/domain/builtin-models.ts";
import { balanceText, CHEAPER_SPEC, parseAccount, parseModels } from "@accounts-proxy/provider-cheaper-inference/domain/cheaper-inference.ts";

const spec = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", file), "utf8"));

describe("Cheaper Inference rules", () => {
  test("C1, C2, C8: bearer on every endpoint, count_tokens, x-ci-request-id", () => {
    expect(CHEAPER_SPEC.apiBase).toBe("https://api.cheaperinference.com/v1");
    expect(Object.values(CHEAPER_SPEC.endpoints)).toEqual([{ path: "/chat/completions" }, { path: "/responses" }, { path: "/messages" }]);
    expect(CHEAPER_SPEC.countTokens).toEqual({ path: "/messages/count_tokens" });
    expect(CHEAPER_SPEC.requestIdHeader).toBe("x-ci-request-id");
  });

  test("C3/C4: the committed public list parses to the built-in list; media-only models are left out", () => {
    const models = parseModels(spec("cheaper-inference-public-models.json"));
    expect(models).toEqual([...CHEAPER_BUILTIN]);
    expect(models).toHaveLength(91);
    expect(models[0]).toEqual({
      id: "aion-3.0",
      displayName: "aion-3.0",
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      formats: ["openai-chat", "openai-responses", "anthropic-messages"],
      details: { input: ["text"], output: ["text"], reasoning: true, cost: [{ input: 1.65, output: 3.3, cacheRead: 0.4125, cacheWrite: 1.65 }] },
    });
  });

  test("parseModels: data[] or models[], endpoint and supported_endpoints, unknown endpoints dropped", () => {
    expect(parseModels({ data: [{ id: "a", endpoint: "/v1/responses" }, { id: "b", supported_endpoints: ["/v1/images/generations"] }, { id: "c", supported_endpoints: [3, "/v1/messages"] }, { id: 1 }, "x", { id: "d" }, { id: "e", endpoint: "/v1/chat/completions", supported_endpoints: ["/v1/chat/completions", "/v1/responses"] }] })).toEqual([
      { id: "a", displayName: "a", formats: ["openai-responses"] },
      { id: "c", displayName: "c", formats: ["anthropic-messages"] },
      { id: "e", displayName: "e", formats: ["openai-chat", "openai-responses"] },
    ]);
    expect(parseModels({ models: [{ id: "e", supported_endpoints: ["/v1/chat/completions"] }] })).toEqual([{ id: "e", displayName: "e", formats: ["openai-chat"] }]);
    expect(parseModels({ other: [] })).toEqual([]);
    expect(parseModels(null)).toEqual([]);
  });

  test("C6: the account identity", () => {
    expect(parseAccount({ email: "me@x", workspace_name: "Team" })).toEqual({ id: "me@x", label: "Team" });
    expect(parseAccount({ email: "me@x", workspace_name: "" })).toEqual({ id: "me@x", label: "me@x" });
    expect(parseAccount({ workspace_name: "Team" })).toEqual({ id: undefined, label: "Team" });
    expect(parseAccount(null)).toEqual({ id: undefined, label: undefined });
  });

  test("C7: the wallet report", () => {
    expect(balanceText({ currency: "USD", balance_usd: 12.5, available_usd: "10.000000", reserved_usd: 2.5, card: "x" })).toBe(
      'Cheaper Inference wallet (GET /v1/account/balance):\n  currency: "USD"\n  balance_usd: 12.5\n  available_usd: "10.000000"\n  reserved_usd: 2.5',
    );
    expect(balanceText([])).toBe("Cheaper Inference wallet (GET /v1/account/balance):");
  });
});

describe("Cheaper Inference model details (plan 2026-10-16 C3)", () => {
  const row = { id: "m", endpoint: "/v1/chat/completions" };
  test("media from the flags, prices per million, the above-threshold prices as a context tier", () => {
    expect(parseModels({ data: [row] })).toEqual([{ id: "m", displayName: "m", formats: ["openai-chat"] }]);
    const [m] = parseModels({
      data: [{ ...row, model_type: "text", supports_vision: true, supports_video: true, supports_reasoning: false, input_per_million: "1", output_per_million: "2", input_token_price_threshold: 1000, input_per_million_above_threshold: "3", output_per_million_above_threshold: "4" }],
    });
    expect(m!.details).toEqual({ input: ["text", "image", "video"], output: ["text"], reasoning: false, cost: [{ input: 1, output: 2 }, { input: 3, output: 4, tier: { type: "context", size: 1000 } }] });
    const [n] = parseModels({ data: [{ ...row, model_type: "image", input_per_million: "1", output_per_million: "2", input_token_price_threshold: 1000, input_per_million_above_threshold: "3" }] });
    expect(n!.details).toEqual({ cost: [{ input: 1, output: 2 }] });
    expect(parseModels({ data: [{ ...row, input_per_million: "1" }] })[0]!.details).toBeUndefined();
  });
});
