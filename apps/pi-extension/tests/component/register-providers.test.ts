// Component tests for feature pi-extension (uc-pi-4, uc-pi-6): the real service and adapters in
// process, with local fakes for fetch (serving a document produced by the real PiConfigCodec over a
// fixture catalog) and execFile.
import { describe, expect, test } from "bun:test";
import { PiConfigCodec } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-config-codec.ts";
import type { FetchFn } from "@accounts-proxy/pi-extension/adapters/outbound/http-proxy-discovery.ts";
import { HttpProxyDiscovery } from "@accounts-proxy/pi-extension/adapters/outbound/http-proxy-discovery.ts";
import type { ExecFileFn } from "@accounts-proxy/pi-extension/adapters/outbound/exec-token-source.ts";
import { ExecTokenSource } from "@accounts-proxy/pi-extension/adapters/outbound/exec-token-source.ts";
import type { PiExtensionApi } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import { ExtensionPiHost } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import type { PiProviderConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";
import { RegisterProvidersService } from "@accounts-proxy/pi-extension/application/register-providers.ts";
import { buildExtension } from "@accounts-proxy/pi-extension/composition/extension-container.ts";
import type { JsonObject } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";

const BASE = "http://proxy.test";
const ENV = "ACCOUNTS_PROXY_TOKEN";
const TOKEN_COMMAND = ["component-token-command"];
const AT: ClientOrigin = { origin: BASE, tokenCommand: TOKEN_COMMAND };

function catalogWith(suffix: string): DetailedCatalog[] {
  return [
    {
      provider: "claude",
      source: "static",
      models: [
        {
          id: `claude/claude-opus-4-6${suffix}`,
          provider: "claude",
          model: `claude-opus-4-6${suffix}`,
          name: "Claude Opus 4.6",
          formats: ["anthropic-messages"],
          aiSdkPackage: "@ai-sdk/anthropic",
          sources: {},
        },
      ],
    },
    {
      provider: "openai",
      source: "static",
      models: [
        {
          id: `openai/gpt-5.6-sol${suffix}`,
          provider: "openai",
          model: `gpt-5.6-sol${suffix}`,
          name: "GPT 5.6 Sol",
          formats: ["openai-responses"],
          aiSdkPackage: "@ai-sdk/openai",
          sources: {},
        },
      ],
    },
  ];
}

function docFor(suffix: string): JsonObject {
  return new PiConfigCodec().config(catalogWith(suffix), AT);
}

type ApiCall = { readonly id: string; readonly config: PiProviderConfig };

function setup() {
  let doc = docFor("");
  let configFails = false;
  const fetchCalls: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    fetchCalls.push(url);
    if (url === `${BASE}/.well-known/pi`) {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ auth: { command: TOKEN_COMMAND, env: ENV }, config: { url: `${BASE}/pi/models.json` } }) };
    }
    if (configFails) {
      return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) };
    }
    const headers = init.headers ?? {};
    if (headers["authorization"] !== "Bearer component-token") {
      return { ok: false, status: 401, statusText: "Unauthorized", json: async () => ({ error: { code: "unauthorized", message: "bad token" } }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => doc };
  };
  const execCalls: string[][] = [];
  const execFileFn: ExecFileFn = async (file, args) => {
    execCalls.push([file, ...args]);
    return { stdout: "component-token\n" };
  };
  const registered: ApiCall[] = [];
  const api: PiExtensionApi = {
    registerProvider(id, config) {
      registered.push({ id, config });
    },
  };
  const written: string[] = [];
  const service = new RegisterProvidersService(
    new HttpProxyDiscovery(fetchFn, BASE),
    new ExecTokenSource(execFileFn),
    new ExtensionPiHost(api, {}, { write: (message) => void written.push(message) }),
  );
  return {
    service,
    registered,
    written,
    fetchCalls,
    execCalls,
    setDoc: (next: JsonObject) => {
      doc = next;
    },
    failConfig: () => {
      configFails = true;
    },
  };
}

/** Every registered model carries the fields pi requires, with the documented types. */
function expectPiValid(models: readonly { [key: string]: unknown }[]): void {
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) {
    expect(typeof model["id"]).toBe("string");
    expect(typeof model["name"]).toBe("string");
    expect(model["input"]).toEqual(["text"]);
    expect(model["cost"]).toEqual({ input: expect.any(Number), output: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number) });
    expect(typeof model["reasoning"]).toBe("boolean");
    expect(typeof model["contextWindow"]).toBe("number");
    expect(typeof model["maxTokens"]).toBe("number");
  }
}

describe("pi-extension", () => {
  test("every available provider registers with pi-valid models [feature=pi-extension use-case=uc-pi-4 tier=component polarity=positive]", async () => {
    // The real factory graph with ACCOUNTS_PROXY_URL unset: the manifest must go to the loopback
    // default. Fetch is faked locally; the token comes preset so no command runs.
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      if (url === "http://127.0.0.1:4141/.well-known/pi") {
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ auth: { command: TOKEN_COMMAND, env: ENV }, config: { url: "http://127.0.0.1:4141/pi/models.json" } }) };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => docFor("") };
    }) as unknown as typeof fetch;
    const registered: ApiCall[] = [];
    const written: string[] = [];
    try {
      await buildExtension({ registerProvider: (id, config) => void registered.push({ id, config }) }, { [ENV]: "component-token" }).run();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(written).toEqual([]);
    expect(seen).toEqual(["http://127.0.0.1:4141/.well-known/pi", "http://127.0.0.1:4141/pi/models.json"]);
    expect(registered.map((r) => r.id).sort()).toEqual(["ap-claude", "ap-openai"]);
    for (const { config } of registered) {
      expect(typeof config.apiKey).toBe("string");
      expectPiValid(config.models as unknown as { [key: string]: unknown }[]);
      expect(typeof config.refreshModels).toBe("function");
    }
  });

  test("the default export against a closed port warns once and registers nothing [feature=pi-extension use-case=uc-pi-4 tier=component polarity=negative]", async () => {
    const registered: ApiCall[] = [];
    const written: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk: unknown): boolean {
      written.push(String(chunk));
      return true;
    } as typeof process.stderr.write;
    const previous = process.env["ACCOUNTS_PROXY_URL"];
    process.env["ACCOUNTS_PROXY_URL"] = "http://127.0.0.1:9";
    try {
      const extension = (await import("@accounts-proxy/pi-extension/main/extension.ts")).default;
      await extension({ registerProvider: (id, config) => void registered.push({ id, config }) });
    } finally {
      process.stderr.write = originalWrite;
      if (previous === undefined) delete process.env["ACCOUNTS_PROXY_URL"];
      else process.env["ACCOUNTS_PROXY_URL"] = previous;
    }
    expect(registered).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^accounts-proxy: .*; no ap- providers registered\n$/);
  });

  test("refresh returns the updated models after the document changes [feature=pi-extension use-case=uc-pi-6 tier=component polarity=positive]", async () => {
    const { service, registered, written, setDoc, execCalls } = setup();
    await service.run();
    expect(written).toEqual([]);
    expect(execCalls).toEqual([TOKEN_COMMAND]);
    setDoc(docFor("-v2"));
    const models = await registered.find((r) => r.id === "ap-claude")!.config.refreshModels!();
    expect(models.map((m) => m.id)).toEqual(["claude/claude-opus-4-6-v2"]);
  });

  test("a failing refresh rejects and leaves the previous registration untouched [feature=pi-extension use-case=uc-pi-6 tier=component polarity=negative]", async () => {
    const { service, registered, written, failConfig } = setup();
    await service.run();
    const before = registered.find((r) => r.id === "ap-openai")!.config.models.map((m) => m.id);
    failConfig();
    const refresh = registered.find((r) => r.id === "ap-openai")!.config.refreshModels!;
    await expect(refresh()).rejects.toThrow("Service Unavailable");
    expect(registered.find((r) => r.id === "ap-openai")!.config.models.map((m) => m.id)).toEqual(before);
    expect(registered).toHaveLength(2);
    expect(written).toEqual([]);
  });
});
