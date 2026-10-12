import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount } from "@inference-router/core/domain/accounts.ts";
import { apiKeyAccount } from "@inference-router/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { GatewayKeySession } from "@inference-router/provider-gateway/adapters/outbound/gateway-key-session.ts";
import { OpenRouterCatalogSource } from "@inference-router/provider-openrouter/adapters/outbound/openrouter-catalog-source.ts";
import { OpenRouterOAuthClient } from "@inference-router/provider-openrouter/adapters/outbound/openrouter-oauth-client.ts";
import { OpenRouterQuota } from "@inference-router/provider-openrouter/adapters/outbound/openrouter-quota.ts";
import { HEADLESS_REDIRECT } from "@inference-router/provider-openrouter/domain/openrouter.ts";
import { FixedClock, MemoryCredentialStore, ScriptedTransport } from "@inference-router/test-support/fakes.ts";

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
  }
}

const exchange = { code: "c", state: "s", redirectUri: "http://localhost:1/callback", codeVerifier: "v", nonce: "n", callback: {} };

describe("OpenRouterOAuthClient (R5–R7)", () => {
  test("loopback and headless authorization URLs; the callback path and the headless marker", async () => {
    const client = new OpenRouterOAuthClient(new ScriptedTransport(() => ({ status: 500 })), new Hash(), "http://auth/auth", "http://api/api/v1");
    expect([client.provider, client.callbackPath, client.manualRedirectUri, client.redirectUri(7)]).toEqual(["openrouter", "/callback", HEADLESS_REDIRECT, "http://localhost:7/callback"]);
    const url = new URL(await client.authorizeUrl({ redirectUri: "http://localhost:7/callback", state: "s", codeChallenge: "c", nonce: "n", fresh: false }));
    expect(url.searchParams.get("callback_url")).toBe("http://localhost:7/callback");
    expect(new URL(await client.authorizeUrl({ redirectUri: HEADLESS_REDIRECT, state: "s", codeChallenge: "c", nonce: "n", fresh: false })).searchParams.has("callback_url")).toBe(false);
    expect(client.successRedirect()).toBeUndefined();
  });

  test("the code exchange: JSON body with the verifier; the key becomes an API-key account named by user_id (else the key hash)", async () => {
    const answers = [{ key: "sk-or-v1-a", user_id: "user_9" }, { key: "sk-or-v1-b" }, { user_id: "user_9" }];
    const transport = new ScriptedTransport((_, i) => ({ status: 200, body: JSON.stringify(answers[i]) }));
    const client = new OpenRouterOAuthClient(transport, new Hash(), "http://auth/auth", "http://api/api/v1");
    expect(await client.exchange(exchange)).toEqual({ provider: "openrouter", id: "user_9", label: "user_9", data: { apiKey: "sk-or-v1-a" } });
    expect(await client.exchange(exchange)).toEqual({ provider: "openrouter", id: "key-deadbeef", label: "key-deadbeef", data: { apiKey: "sk-or-v1-b" } });
    await expect(client.exchange(exchange)).rejects.toThrow("openrouter: no API key entered");
    const sent = transport.requests[0]!;
    expect([sent.method, sent.url, sent.headers["content-type"], JSON.parse(sent.body!), sent.timeoutMs]).toEqual(["POST", "http://api/api/v1/auth/keys", "application/json", { code: "c", code_verifier: "v", code_challenge_method: "S256" }, 30_000]);
  });

  test("a refused exchange needs a new login", async () => {
    const client = new OpenRouterOAuthClient(new ScriptedTransport(() => ({ status: 403, body: '{"error":{"code":403,"message":"Invalid code or code_verifier"}}' })), new Hash(), "http://auth/auth", "http://api/api/v1");
    await expect(client.exchange(exchange)).rejects.toThrow(ProviderAuthRequiredError);
    await expect(client.exchange(exchange)).rejects.toThrow("key exchange failed: HTTP 403");
  });
});

describe("OpenRouterCatalogSource (R4)", () => {
  test("GET /models without a key; a non-200 answer fails", async () => {
    const transport = new ScriptedTransport((_, i) => (i === 0 ? { status: 200, body: JSON.stringify({ data: [{ id: "a/b", name: "A B" }] }) } : { status: 503 }));
    const source = new OpenRouterCatalogSource(transport, "http://api/api/v1");
    expect(await source.fetch()).toEqual([{ id: "a/b", displayName: "A B" }]);
    expect([transport.requests[0]!.url, transport.requests[0]!.headers]).toEqual(["http://api/api/v1/models", { accept: "application/json" }]);
    await expect(source.fetch()).rejects.toThrow("model list HTTP 503");
  });
});

describe("OpenRouterQuota (R8)", () => {
  test("GET /key with the active key; a failure is reported", async () => {
    const store = new MemoryCredentialStore();
    store.seed("openrouter", upsertAccount(EMPTY_POOL, apiKeyAccount("openrouter", "user_9", "user_9", "sk-or-v1-a")));
    const transport = new ScriptedTransport((_, i) => (i === 0 ? { status: 200, body: JSON.stringify({ data: { label: "l", usage: 0, limit: null } }) } : { status: 401, body: "nope" }));
    const quota = new OpenRouterQuota(transport, new GatewayKeySession("openrouter", store), new FixedClock(5), "http://api/api/v1");
    expect(quota.provider).toBe("openrouter");
    expect(await quota.usage()).toEqual({ capturedAt: 5, text: 'OpenRouter key (GET /key):\n  label: "l"\n  usage: 0\n  limit: null' });
    expect(transport.requests[0]!.headers["authorization"]).toBe("Bearer sk-or-v1-a");
    await expect(quota.usage()).rejects.toThrow("openrouter: GET /key HTTP 401 nope");
  });
});
