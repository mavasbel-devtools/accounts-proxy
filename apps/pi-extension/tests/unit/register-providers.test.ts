// Unit tests for the pi extension's registration flow (uc-pi-4, uc-pi-6).
import { describe, expect, test } from "bun:test";
import { RegisterProvidersService, piDefaults } from "@accounts-proxy/pi-extension/application/register-providers.ts";
import type { JsonObject, PiManifest } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";
import { ProxyDiscoveryPort } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";
import { TokenSourcePort } from "@accounts-proxy/pi-extension/ports/outbound/token-source.ts";
import type { PiProviderConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";
import { PiHostPort } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";

const ENV = "ACCOUNTS_PROXY_TOKEN";
const URL = "http://127.0.0.1:4141/pi/models.json";
const COMMAND = ["env", "ACCOUNTS_PROXY_HOME=test", "token"];
const MANIFEST: PiManifest = { auth: { command: COMMAND, env: ENV }, config: { url: URL } };

const FULL_MODEL: JsonObject = {
  id: "claude/claude-opus-5-5",
  name: "Claude Opus 5.5",
  api: "anthropic-messages",
  baseUrl: "http://127.0.0.1:4141/anthropic",
  input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 6.25 },
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 32000,
  thinkingLevelMap: { off: null, low: "low" },
  compat: { forceAdaptiveThinking: true },
};

function docWith(models: JsonObject[]): JsonObject {
  return {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: { "ap-claude": { name: "AP · Claude", apiKey: "$ACCOUNTS_PROXY_TOKEN", models } },
  };
}

class FakeDiscovery extends ProxyDiscoveryPort {
  manifestCalls = 0;
  manifestError: unknown;
  configCalls: { readonly url: string; readonly token: string }[] = [];
  configError: unknown;
  configDoc: JsonObject = docWith([FULL_MODEL]);
  async manifest(): Promise<PiManifest> {
    this.manifestCalls += 1;
    if (this.manifestError !== undefined) throw this.manifestError;
    return MANIFEST;
  }
  async config(url: string, token: string): Promise<JsonObject> {
    this.configCalls.push({ url, token });
    if (this.configError !== undefined) throw this.configError;
    return this.configDoc;
  }
}

class FakeTokens extends TokenSourcePort {
  calls: readonly string[][] = [];
  error: unknown;
  value = "fetched-token";
  async token(command: readonly string[]): Promise<string> {
    this.calls = [...this.calls, [...command]];
    if (this.error !== undefined) throw this.error;
    return this.value;
  }
}

class FakeHost extends PiHostPort {
  env: Record<string, string> = {};
  setCalls: [string, string][] = [];
  registered: { readonly id: string; readonly config: PiProviderConfig }[] = [];
  warnings: string[] = [];
  registerProvider(id: string, config: PiProviderConfig): void {
    this.registered.push({ id, config });
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  readEnv(name: string): string | undefined {
    return this.env[name];
  }
  setEnv(name: string, value: string): void {
    this.setCalls.push([name, value]);
    this.env[name] = value;
  }
}

function setup() {
  const discovery = new FakeDiscovery();
  const tokens = new FakeTokens();
  const host = new FakeHost();
  const service = new RegisterProvidersService(discovery, tokens, host);
  return { discovery, tokens, host, service };
}

describe("RegisterProvidersService", () => {
  test("uses the preset token and registers every provider with its document name [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const { discovery, tokens, host, service } = setup();
    host.env[ENV] = "preset-token";
    await service.run();
    expect(tokens.calls).toEqual([]);
    expect(host.setCalls).toEqual([]);
    expect(discovery.configCalls).toEqual([{ url: URL, token: "preset-token" }]);
    expect(host.registered.map((r) => r.id)).toEqual(["ap-claude"]);
    const config = host.registered[0]!.config;
    expect(config.name).toBe("AP · Claude");
    expect(config.apiKey).toBe("$ACCOUNTS_PROXY_TOKEN");
    expect(config.models).toHaveLength(1);
    expect(config.models[0]!.id).toBe("claude/claude-opus-5-5");
    expect(typeof config.refreshModels).toBe("function");
    expect(host.warnings).toEqual([]);
  });

  test("fetches the token through the manifest command and stores it when the environment is unset [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const { discovery, tokens, host, service } = setup();
    await service.run();
    expect(tokens.calls).toEqual([COMMAND]);
    expect(host.setCalls).toEqual([[ENV, "fetched-token"]]);
    expect(discovery.configCalls).toEqual([{ url: URL, token: "fetched-token" }]);
    expect(host.registered.map((r) => r.id)).toEqual(["ap-claude"]);
    expect(host.warnings).toEqual([]);
  });

  test("a manifest failure warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { host } = setup();
    const failing = new FakeDiscovery();
    failing.manifestError = new Error("connection refused");
    const retry = new RegisterProvidersService(failing, new FakeTokens(), host);
    await retry.run();
    expect(host.warnings).toEqual(["accounts-proxy: connection refused; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a token failure warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { tokens, host, service } = setup();
    tokens.error = new Error("token command exited 1");
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: token command exited 1; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a config failure warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    discovery.configError = new Error("config 401: unauthorized");
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: config 401: unauthorized; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a document without a providers object warns [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    discovery.configDoc = { providers: [] };
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: not a pi configuration: providers is not an object; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a provider entry without a model list warns [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    discovery.configDoc = { providers: { "ap-claude": null } };
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: not a pi configuration: provider ap-claude has no model list; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a model without a string id warns [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    discovery.configDoc = { providers: { "ap-claude": { models: [{ name: "no id" }] } } };
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: not a pi configuration: model without a string id; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a non-Error rejection is reported by its string value [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    discovery.manifestError = "string boom";
    await service.run();
    expect(host.warnings).toEqual(["accounts-proxy: string boom; no ap- providers registered"]);
    expect(host.registered).toEqual([]);
  });

  test("a provider without a name or apiKey registers without them [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const { discovery, host, service } = setup();
    discovery.configDoc = { providers: { "ap-claude": { models: [{ id: "m" }] } } };
    await service.run();
    expect(host.warnings).toEqual([]);
    expect(host.registered).toHaveLength(1);
    const config = host.registered[0]!.config;
    expect("name" in config).toBe(false);
    expect("apiKey" in config).toBe(false);
    expect(config.models).toHaveLength(1);
  });

  test("refresh returns the updated models after the document changes [feature=pi-extension use-case=uc-pi-6 tier=unit polarity=positive]", async () => {
    const { discovery, host, service } = setup();
    await service.run();
    expect(discovery.manifestCalls).toBe(1);
    discovery.configDoc = docWith([{ ...FULL_MODEL, id: "claude/claude-haiku-4-5-20251001" }]);
    const refresh = host.registered[0]!.config.refreshModels;
    expect(refresh).toBeDefined();
    const models = await refresh!();
    expect(models.map((m) => m.id)).toEqual(["claude/claude-haiku-4-5-20251001"]);
    expect(discovery.manifestCalls).toBe(2);
  });

  test("a refresh failure rejects and leaves the previous registration untouched [feature=pi-extension use-case=uc-pi-6 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    await service.run();
    discovery.configError = new Error("daemon stopped");
    const refresh = host.registered[0]!.config.refreshModels;
    await expect(refresh!()).rejects.toThrow("daemon stopped");
    expect(host.registered).toHaveLength(1);
    expect(host.registered[0]!.config.models.map((m) => m.id)).toEqual(["claude/claude-opus-5-5"]);
    expect(host.warnings).toEqual([]);
  });

  test("refresh returns an empty list when the provider disappeared [feature=pi-extension use-case=uc-pi-6 tier=unit polarity=negative]", async () => {
    const { discovery, host, service } = setup();
    await service.run();
    discovery.configDoc = { providers: { "ap-other": { models: [{ id: "x" }] } } };
    const refresh = host.registered[0]!.config.refreshModels;
    await expect(refresh!()).resolves.toEqual([]);
  });
});

describe("piDefaults", () => {
  test("fills each of the six defaulted fields [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    expect(piDefaults({ id: "m" })).toEqual({
      id: "m",
      name: "m",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  test("keeps every stated field [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    expect(piDefaults(FULL_MODEL)).toEqual({
      id: "claude/claude-opus-5-5",
      name: "Claude Opus 5.5",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:4141/anthropic",
      input: ["text"],
      cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 6.25 },
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 32000,
      thinkingLevelMap: { off: null, low: "low" },
      compat: { forceAdaptiveThinking: true },
    });
  });

  test("a partial cost fills the missing rates with zero [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    expect(piDefaults({ id: "m", cost: { input: 2 } }).cost).toEqual({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("a model without a string id throws [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", () => {
    expect(() => piDefaults({ id: 1 })).toThrow("not a pi configuration: model without a string id");
  });
});
