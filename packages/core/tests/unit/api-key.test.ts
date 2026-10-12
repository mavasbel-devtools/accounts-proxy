import { describe, expect, test } from "bun:test";
import { apiKeyAccount, apiKeyOf, keyAccountId, normalizeApiKey } from "@inference-router/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";

describe("API-key accounts (plan P4.6 §2 item 3)", () => {
  test("an account holds the key in data.apiKey; apiKeyOf reads it back", () => {
    const account = apiKeyAccount("cheaper-inference", "me@x", "Team", "ci_live_1");
    expect(account).toEqual({ provider: "cheaper-inference", id: "me@x", label: "Team", data: { apiKey: "ci_live_1" } });
    expect(apiKeyOf(account)).toBe("ci_live_1");
  });

  test("an account without a key needs a login", () => {
    for (const data of [{}, { apiKey: "" }, { apiKey: 1 }]) {
      expect(() => apiKeyOf({ provider: "opencode", id: "k", label: "k", data })).toThrow(ProviderAuthRequiredError);
    }
    expect(() => apiKeyOf({ provider: "opencode", id: "k", label: "k", data: {} })).toThrow("opencode: account k has no API key; run `inference-router login opencode`");
  });

  test("keyAccountId: key- and the first 8 hex digits of the digest", () => {
    expect(keyAccountId(Uint8Array.from([0x0a, 0xbc, 0x01, 0xff, 0x99]))).toBe("key-0abc01ff");
  });

  test("normalizeApiKey trims; an empty key is refused", () => {
    expect(normalizeApiKey("openrouter", "  sk-or-1 \n")).toBe("sk-or-1");
    expect(() => normalizeApiKey("openrouter", "   ")).toThrow("openrouter: no API key entered");
  });
});
