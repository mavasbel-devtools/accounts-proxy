import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_CONFIG, enabledProviders, parseRouterConfig } from "@inference-router/core/domain/config.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import { codeFromCallback, codeFromManualInput, loopbackRedirectUri } from "@inference-router/core/domain/services/oauth-flow.ts";

describe("parseRouterConfig", () => {
  test("no document → defaults, everything disabled, port 4141", () => {
    expect(parseRouterConfig(undefined)).toBe(DEFAULT_CONFIG);
    expect(parseRouterConfig(null)).toBe(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.port).toBe(4141);
    expect(enabledProviders(DEFAULT_CONFIG)).toEqual([]);
    expect(parseRouterConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("the example configuration enables both providers", () => {
    const config = parseRouterConfig({
      port: 4141,
      providers: { "claude-subscription": { enabled: true, acknowledgeTermsRisk: true }, antigravity: { enabled: true, acknowledgeTermsRisk: true } },
      aliases: { opus: "claude-subscription/claude-opus-4-8" },
    });
    expect(enabledProviders(config)).toEqual(["claude-subscription", "antigravity"]);
    expect(config.aliases).toEqual({ opus: "claude-subscription/claude-opus-4-8" });
  });

  test("acknowledged but disabled stays disabled", () => {
    expect(enabledProviders(parseRouterConfig({ providers: { antigravity: { acknowledgeTermsRisk: true } } }))).toEqual([]);
  });

  test.each([
    [[], "the document must be a mapping"],
    [{ extra: 1 }, "unknown key(s) extra in the document"],
    [{ port: 0 }, "port must be an integer 1-65535"],
    [{ port: 65536 }, "port must be an integer 1-65535"],
    [{ port: 41.5 }, "port must be an integer 1-65535"],
    [{ port: "4141" }, "port must be an integer 1-65535"],
    [{ providers: [] }, "providers must be a mapping"],
    [{ providers: { cheaper: {} } }, "unknown provider cheaper"],
    [{ providers: { antigravity: true } }, "providers.antigravity must be a mapping"],
    [{ providers: { antigravity: { enable: true } } }, "unknown key(s) enable in providers.antigravity"],
    [{ providers: { antigravity: { enabled: "yes" } } }, "providers.antigravity.enabled must be true or false"],
    [{ providers: { antigravity: { enabled: true } } }, "enabled without acknowledgeTermsRisk: true"],
    [{ providers: { antigravity: { enabled: true, acknowledgeTermsRisk: false } } }, "enabled without acknowledgeTermsRisk: true"],
    [{ aliases: "x" }, "aliases must be a mapping"],
    [{ aliases: { a: 1 } }, "aliases.a must be a <provider>/<model> string"],
    [{ aliases: { a: "gpt-4o" } }, 'aliases.a = "gpt-4o" is not <provider>/<model>'],
  ])("%p is rejected", (raw, message) => {
    expect(() => parseRouterConfig(raw)).toThrow(ConfigError);
    expect(() => parseRouterConfig(raw)).toThrow(message);
  });
});

describe("oauth flow", () => {
  test("loopback redirect uri", () => {
    expect(loopbackRedirectUri(5555, "/callback")).toBe("http://localhost:5555/callback");
  });

  test("callback validation", () => {
    expect(codeFromCallback("antigravity", { code: "c", state: "s" }, "s")).toBe("c");
    const cases: [Record<string, string>, string][] = [
      [{ error: "access_denied", state: "s" }, "authorization failed: access_denied"],
      [{ error: "access_denied", error_description: "user said no" }, "authorization failed: access_denied (user said no)"],
      [{ code: "c", state: "other" }, "authorization state mismatch"],
      [{ code: "c" }, "authorization state mismatch"],
      [{ state: "s" }, "authorization code missing"],
      [{ state: "s", code: "" }, "authorization code missing"],
    ];
    for (const [query, message] of cases) {
      expect(() => codeFromCallback("antigravity", query, "s")).toThrow(ProviderAuthRequiredError);
      expect(() => codeFromCallback("antigravity", query, "s")).toThrow(message);
    }
  });

  test("manual code: code, code#state, state checked, empty refused", () => {
    expect(codeFromManualInput("claude-subscription", "  abc  ", "s")).toBe("abc");
    expect(codeFromManualInput("claude-subscription", "a#b#s", "s")).toBe("a#b");
    expect(() => codeFromManualInput("claude-subscription", "abc#zzz", "s")).toThrow("authorization state mismatch");
    expect(() => codeFromManualInput("claude-subscription", "  ", "s")).toThrow("no authorization code entered");
    expect(() => codeFromManualInput("claude-subscription", "#s", "s")).toThrow("no authorization code entered");
  });
});
