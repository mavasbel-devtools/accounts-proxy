import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_CONFIG, DEFAULT_MODEL_LIST_MAX_AGE_MINUTES, enabledProviders, modelListMaxAgeMs, parseProxyConfig } from "@accounts-proxy/core/domain/config.ts";
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import { codeFromCallback, codeFromManualInput, loopbackRedirectUri } from "@accounts-proxy/core/domain/services/oauth-flow.ts";

describe("parseProxyConfig", () => {
  test("no document → defaults, everything disabled, port 4141", () => {
    expect(parseProxyConfig(undefined)).toBe(DEFAULT_CONFIG);
    expect(parseProxyConfig(null)).toBe(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.port).toBe(4141);
    expect(enabledProviders(DEFAULT_CONFIG)).toEqual([]);
    expect(parseProxyConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("the example configuration enables both providers", () => {
    const config = parseProxyConfig({
      port: 4141,
      providers: { claude: { enabled: true, acknowledgeTermsRisk: true }, antigravity: { enabled: true, acknowledgeTermsRisk: true } },
      aliases: { opus: "claude/claude-opus-4-8" },
    });
    expect(enabledProviders(config)).toEqual(["claude", "antigravity"]);
    expect(config.aliases).toEqual({ opus: "claude/claude-opus-4-8" });
  });

  test("an API-key gateway needs only enabled: true (plan P4.6 N1); a subscription provider needs the acknowledgement", () => {
    const config = parseProxyConfig({ providers: { openrouter: { enabled: true }, "cheaper-inference": { enabled: true, acknowledgeTermsRisk: false } } });
    expect(enabledProviders(config)).toEqual(["openrouter", "cheaper-inference"]);
    expect(() => parseProxyConfig({ providers: { openai: { enabled: true } } })).toThrow("enabled without acknowledgeTermsRisk: true");
  });

  test("logs: usage on, 15 days, 100 MB, 500 MB total by default; each key read (plan 2026-10-27-23-29 L4, plan 2026-11-01-17-27)", () => {
    expect(DEFAULT_CONFIG.logs).toEqual({ usage: true, retentionDays: 15, maxFileMegabytes: 100, maxTotalMegabytes: 500 });
    expect(parseProxyConfig({}).logs).toEqual({ usage: true, retentionDays: 15, maxFileMegabytes: 100, maxTotalMegabytes: 500 });
    expect(parseProxyConfig({ logs: { usage: false } }).logs).toEqual({ usage: false, retentionDays: 15, maxFileMegabytes: 100, maxTotalMegabytes: 500 });
    expect(parseProxyConfig({ logs: { retentionDays: 1, maxFileMegabytes: 7, maxTotalMegabytes: 200 } }).logs).toEqual({ usage: true, retentionDays: 1, maxFileMegabytes: 7, maxTotalMegabytes: 200 });
  });

  test("modelListMaxAgeMinutes: default 1440 (24 h), any positive integer (plan 2026-10-26 R1)", () => {
    expect([DEFAULT_CONFIG.modelListMaxAgeMinutes, DEFAULT_MODEL_LIST_MAX_AGE_MINUTES, modelListMaxAgeMs(DEFAULT_CONFIG)]).toEqual([1440, 1440, 86_400_000]);
    const config = parseProxyConfig({ modelListMaxAgeMinutes: 10 });
    expect([config.modelListMaxAgeMinutes, modelListMaxAgeMs(config)]).toEqual([10, 600_000]);
  });

  test("acknowledged but disabled stays disabled", () => {
    expect(enabledProviders(parseProxyConfig({ providers: { antigravity: { acknowledgeTermsRisk: true } } }))).toEqual([]);
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
    [{ exchangeLog: { enabled: true } }, "exchangeLog was replaced by logs: { usage, retentionDays, maxFileMegabytes } (plan 2026-10-27-23-29)"],
    [{ logs: [] }, "logs must be a mapping"],
    [{ logs: { keep: 1 } }, "unknown key(s) keep in logs"],
    [{ logs: { retentionDays: 0 } }, "logs.retentionDays must be a positive integer (days)"],
    [{ logs: { retentionDays: "7" } }, "logs.retentionDays must be a positive integer (days)"],
    [{ logs: { maxFileMegabytes: 1.5 } }, "logs.maxFileMegabytes must be a positive integer (megabytes)"],
    [{ logs: { maxTotalMegabytes: 0 } }, "logs.maxTotalMegabytes must be a positive integer (megabytes)"],
    [{ logs: { maxTotalMegabytes: -1 } }, "logs.maxTotalMegabytes must be a positive integer (megabytes)"],
    [{ logs: { maxTotalMegabytes: "500" } }, "logs.maxTotalMegabytes must be a positive integer (megabytes)"],
    [{ logs: { usage: "yes" } }, "logs.usage must be true or false"],
    [{ modelListMaxAgeMinutes: 0 }, "modelListMaxAgeMinutes must be a positive integer (minutes)"],
    [{ modelListMaxAgeMinutes: 1.5 }, "modelListMaxAgeMinutes must be a positive integer (minutes)"],
    [{ modelListMaxAgeMinutes: "10" }, "modelListMaxAgeMinutes must be a positive integer (minutes)"],
    [{ aliases: "x" }, "aliases must be a mapping"],
    [{ aliases: { a: 1 } }, "aliases.a must be a <provider>/<model> string"],
    [{ aliases: { a: "gpt-4o" } }, 'aliases.a = "gpt-4o" is not <provider>/<model>'],
  ])("%p is rejected", (raw, message) => {
    expect(() => parseProxyConfig(raw)).toThrow(ConfigError);
    expect(() => parseProxyConfig(raw)).toThrow(message);
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
    expect(codeFromManualInput("claude", "  abc  ", "s")).toBe("abc");
    expect(codeFromManualInput("claude", "a#b#s", "s")).toBe("a#b");
    expect(() => codeFromManualInput("claude", "abc#zzz", "s")).toThrow("authorization state mismatch");
    expect(() => codeFromManualInput("claude", "  ", "s")).toThrow("no authorization code entered");
    expect(() => codeFromManualInput("claude", "#s", "s")).toThrow("no authorization code entered");
  });
});
