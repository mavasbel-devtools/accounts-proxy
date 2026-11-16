// Unit tests for ExtensionPiHost (uc-pi-4): injected api, env and stderr, no I/O.
import { describe, expect, test } from "bun:test";
import type { PiExtensionApi } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import { ExtensionPiHost } from "@accounts-proxy/pi-extension/adapters/outbound/extension-pi-host.ts";
import type { PiProviderConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";

function setup() {
  const registered: { id: string; config: PiProviderConfig }[] = [];
  const api: PiExtensionApi = {
    registerProvider(id, config) {
      registered.push({ id, config });
    },
  };
  const env: Record<string, string | undefined> = {};
  const written: string[] = [];
  const host = new ExtensionPiHost(api, env, { write: (message) => void written.push(message) });
  return { host, registered, env, written };
}

describe("ExtensionPiHost", () => {
  test("registerProvider forwards the id and config to pi [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    const { host, registered } = setup();
    const config: PiProviderConfig = { models: [] };
    host.registerProvider("ap-claude", config);
    expect(registered).toEqual([{ id: "ap-claude", config }]);
  });

  test("warn writes the message with a trailing newline [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    const { host, written } = setup();
    host.warn("accounts-proxy: down; no ap- providers registered");
    expect(written).toEqual(["accounts-proxy: down; no ap- providers registered\n"]);
  });

  test("readEnv and setEnv use the environment [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", () => {
    const { host, env } = setup();
    expect(host.readEnv("ACCOUNTS_PROXY_TOKEN")).toBeUndefined();
    host.setEnv("ACCOUNTS_PROXY_TOKEN", "secret");
    expect(host.readEnv("ACCOUNTS_PROXY_TOKEN")).toBe("secret");
    expect(env["ACCOUNTS_PROXY_TOKEN"]).toBe("secret");
  });
});
