import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount } from "@accounts-proxy/core/domain/accounts.ts";
import { apiKeyAccount } from "@accounts-proxy/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import { HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { CheaperCatalogSource, CheaperKeyLogin, CheaperQuota } from "@accounts-proxy/provider-cheaper-inference/adapters/outbound/cheaper-inference-adapters.ts";
import { GatewayKeySession } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-key-session.ts";
import { FixedClock, MemoryCredentialStore, ScriptedTransport } from "@accounts-proxy/test-support/fakes.ts";

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([9, 9, 9, 9]);
  }
}

const LIST = JSON.stringify({ data: [{ id: "m", supported_endpoints: ["/v1/chat/completions"] }] });

describe("CheaperCatalogSource (C3, C4)", () => {
  test("with a key: GET /v1/models; without: GET /public/models; a failure fails the fetch", async () => {
    const transport = new ScriptedTransport((_, i) => (i < 2 ? { status: 200, body: LIST } : { status: 500 }));
    const source = new CheaperCatalogSource(transport, "http://ci/v1", "http://ci/public/models");
    expect(await source.fetch("ci_live_1")).toEqual([{ id: "m", displayName: "m", formats: ["openai-chat"] }]);
    expect(await source.fetch(undefined)).toHaveLength(1);
    expect(transport.requests.map((r) => [r.url, r.headers])).toEqual([
      ["http://ci/v1/models", { accept: "application/json", authorization: "Bearer ci_live_1" }],
      ["http://ci/public/models", { accept: "application/json" }],
    ]);
    await expect(source.fetch(undefined)).rejects.toThrow("model list HTTP 500");
  });
});

describe("CheaperKeyLogin (C6)", () => {
  test("GET /v1/account names the account; a refused key needs a new login", async () => {
    const transport = new ScriptedTransport((_, i) => (i === 0 ? { status: 200, body: JSON.stringify({ email: "me@x", workspace_name: "Team" }) } : { status: 401, body: '{"error":{"message":"bad key"}}' }));
    const login = new CheaperKeyLogin(new Hash(), transport, "http://ci/v1");
    expect([login.provider, login.question]).toEqual(["cheaper-inference", "Cheaper Inference API key (dashboard → API keys, ci_live_…): "]);
    expect(await login.account("ci_live_1")).toEqual({ provider: "cheaper-inference", id: "me@x", label: "Team", data: { apiKey: "ci_live_1" } });
    expect([transport.requests[0]!.url, transport.requests[0]!.headers["authorization"]]).toEqual(["http://ci/v1/account", "Bearer ci_live_1"]);
    await expect(login.account("ci_live_2")).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });
});

describe("CheaperQuota (C7)", () => {
  test("GET /v1/account/balance with the active key; a failure is reported", async () => {
    const store = new MemoryCredentialStore();
    store.seed("cheaper-inference", upsertAccount(EMPTY_POOL, apiKeyAccount("cheaper-inference", "me@x", "Team", "ci_live_1")));
    const transport = new ScriptedTransport((_, i) => (i === 0 ? { status: 200, body: JSON.stringify({ currency: "USD", balance_usd: 1, available_usd: 1, reserved_usd: 0 }) } : { status: 402, body: "insufficient" }));
    const quota = new CheaperQuota(transport, new GatewayKeySession("cheaper-inference", store), new FixedClock(7), "http://ci/v1");
    expect(quota.provider).toBe("cheaper-inference");
    expect(await quota.usage()).toEqual({ capturedAt: 7, text: "Cheaper Inference wallet (GET /v1/account/balance):\n  currency: \"USD\"\n  balance_usd: 1\n  available_usd: 1\n  reserved_usd: 0" });
    expect(transport.requests[0]!.url).toBe("http://ci/v1/account/balance");
    await expect(quota.usage()).rejects.toThrow("cheaper-inference: GET /v1/account/balance HTTP 402 insufficient");
  });
});
