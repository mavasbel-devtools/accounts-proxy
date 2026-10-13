import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHEAPER_BUILTIN } from "@inference-router/provider-cheaper-inference/domain/builtin-models.ts";
import { balanceText, CHEAPER_SPEC, parseAccount, parseModels } from "@inference-router/provider-cheaper-inference/domain/cheaper-inference.ts";

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
    expect(models[0]).toEqual({ id: "aion-3.0", displayName: "aion-3.0", contextWindow: 128_000, maxOutputTokens: 32_768, formats: ["openai-chat", "openai-responses", "anthropic-messages"] });
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
