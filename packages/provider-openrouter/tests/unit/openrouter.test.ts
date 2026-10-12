import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENROUTER_BUILTIN } from "@inference-router/provider-openrouter/domain/builtin-models.ts";
import { AUTH_URL, authorizeUrl, HEADLESS_REDIRECT, keyUsageText, OPENROUTER_SPEC, parseKeyExchange, parseModels } from "@inference-router/provider-openrouter/domain/openrouter.ts";

const spec = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", file), "utf8"));

describe("OpenRouter rules", () => {
  test("R1–R3, R11: bearer key, Chat/Responses/Messages for every model, no count_tokens, X-Generation-Id", () => {
    expect(OPENROUTER_SPEC.apiBase).toBe("https://openrouter.ai/api/v1");
    expect(Object.values(OPENROUTER_SPEC.endpoints).map((e) => e.keyHeader)).toEqual(["authorization", "authorization", "authorization"]);
    expect(OPENROUTER_SPEC.uniformFormats).toEqual(["openai-chat", "openai-responses", "anthropic-messages"]);
    expect(OPENROUTER_SPEC.countTokens).toBeUndefined();
    expect(OPENROUTER_SPEC.requestIdHeader).toBe("x-generation-id");
  });

  test("R5: the PKCE URL with a localhost callback and state; R6: the headless URL without either, with the key label", () => {
    const loopback = new URL(authorizeUrl(AUTH_URL, "http://localhost:5000/callback", "st", "ch"));
    expect([loopback.origin + loopback.pathname, Object.fromEntries(loopback.searchParams)]).toEqual([
      "https://openrouter.ai/auth",
      { callback_url: "http://localhost:5000/callback", code_challenge: "ch", code_challenge_method: "S256", state: "st" },
    ]);
    const headless = new URL(authorizeUrl(AUTH_URL, HEADLESS_REDIRECT, "st", "ch"));
    expect(Object.fromEntries(headless.searchParams)).toEqual({ code_challenge: "ch", code_challenge_method: "S256", key_label: "inference-router" });
  });

  test("R7: the key exchange answer", () => {
    expect(parseKeyExchange({ key: "sk-or-v1-x", user_id: "user_1" })).toEqual({ key: "sk-or-v1-x", userId: "user_1" });
    expect(parseKeyExchange({ key: "sk-or-v1-x", user_id: "" })).toEqual({ key: "sk-or-v1-x", userId: undefined });
    for (const bad of [null, {}, { key: "" }, { key: 1 }]) expect(parseKeyExchange(bad)).toEqual({ key: "", userId: undefined });
  });

  test("R4: the committed live list parses to the built-in list (459 models); rows without an id are skipped", () => {
    const models = parseModels(spec("openrouter-models.json"));
    expect(models).toHaveLength(459);
    expect(models).toEqual([...OPENROUTER_BUILTIN]);
    expect(models[0]).toEqual({ id: "meta/muse-wonder", displayName: "Meta: Muse Wonder", contextWindow: 1_048_576, maxOutputTokens: 943_718, createdAt: "2026-10-12T12:25:45.000Z" });
    expect(parseModels({ data: [{ id: "x" }, { name: "no id" }, 3] })).toEqual([{ id: "x", displayName: "x" }]);
    expect(parseModels({ data: [{ id: "y", top_provider: "n/a" }] })).toEqual([{ id: "y", displayName: "y" }]);
    expect(parseModels(null)).toEqual([]);
  });

  test("R8: the key usage report prints the fields OpenRouter answered", () => {
    expect(keyUsageText({ data: { label: "inference-router", usage: 1.5, limit: null, limit_remaining: null, is_free_tier: true, extra: 1 } })).toBe(
      'OpenRouter key (GET /key):\n  label: "inference-router"\n  is_free_tier: true\n  usage: 1.5\n  limit: null\n  limit_remaining: null',
    );
    expect(keyUsageText({})).toBe("OpenRouter key (GET /key):");
  });
});
