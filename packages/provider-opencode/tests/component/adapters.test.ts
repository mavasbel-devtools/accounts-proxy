import { describe, expect, test } from "bun:test";
import { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { OpencodeCatalogSource } from "@inference-router/provider-opencode/adapters/outbound/opencode-catalog-source.ts";
import { OpencodeKeyLogin } from "@inference-router/provider-opencode/adapters/outbound/opencode-key-login.ts";
import { MemoryLogger, ScriptedTransport } from "@inference-router/test-support/fakes.ts";

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([1, 2, 3, 4]);
  }
}

const LIST = JSON.stringify({ object: "list", data: [{ id: "big-pickle" }, { id: "new" }] });
const MODELS_DEV = JSON.stringify({ opencode: { npm: "@ai-sdk/openai-compatible", models: { "big-pickle": { name: "Big Pickle" } } } });

describe("OpencodeCatalogSource (Z4, Z5)", () => {
  test("the gateway's ids described by models.dev", async () => {
    const transport = new ScriptedTransport((r) => ({ status: 200, body: r.url.endsWith("/api.json") ? MODELS_DEV : LIST }));
    const source = new OpencodeCatalogSource("opencode", transport, new MemoryLogger(), "http://gw/zen/v1", "http://md/api.json");
    expect(await source.fetch()).toEqual([
      { id: "big-pickle", displayName: "Big Pickle", formats: ["openai-chat"] },
      { id: "new", displayName: "new" },
    ]);
    expect(transport.requests.map((r) => [r.url, r.headers])).toEqual([
      ["http://gw/zen/v1/models", { accept: "application/json" }],
      ["http://md/api.json", { accept: "application/json" }],
    ]);
  });

  test("models.dev unavailable: the ids without formats, warned; the gateway list failing fails the fetch", async () => {
    const logger = new MemoryLogger();
    const transport = new ScriptedTransport((r) => (r.url.endsWith("/api.json") ? { status: 502 } : { status: 200, body: LIST }));
    expect(await new OpencodeCatalogSource("opencode", transport, logger, "http://gw/zen/v1", "http://md/api.json").fetch()).toEqual([
      { id: "big-pickle", displayName: "big-pickle" },
      { id: "new", displayName: "new" },
    ]);
    expect(logger.lines).toEqual(["WARN opencode: models.dev unavailable (GET http://md/api.json HTTP 502); model formats unknown"]);
    const down = new ScriptedTransport(() => ({ status: 500 }));
    await expect(new OpencodeCatalogSource("opencode-go", down, logger, "http://gw/zen/go/v1", "http://md/api.json").fetch()).rejects.toThrow("GET http://gw/zen/go/v1/models HTTP 500");
  });
});

describe("OpencodeKeyLogin (Z7, Z11)", () => {
  test("Zen: the key format only, no request; the key-hash identity", async () => {
    const transport = new ScriptedTransport(() => ({ status: 500 }));
    const login = new OpencodeKeyLogin("opencode", new Hash(), transport, "http://gw/zen/v1");
    expect(login.question).toBe("OpenCode Zen API key (opencode.ai Console → API keys): ");
    expect(await login.account("oc_sk_1")).toEqual({ provider: "opencode", id: "key-01020304", label: "key-01020304", data: { apiKey: "oc_sk_1" } });
    expect(transport.requests).toHaveLength(0);
    await expect(login.account("ci_live_1")).rejects.toThrow("an OpenCode API key starts with oc_sk_");
  });

  test("Go: one GET /usage with the key; a refusal needs a new login", async () => {
    const transport = new ScriptedTransport((_, i) => (i === 0 ? { status: 200, body: "{}" } : { status: 401, body: '{"type":"error"}' }));
    const login = new OpencodeKeyLogin("opencode-go", new Hash(), transport, "http://gw/zen/go/v1");
    expect(login.question).toBe("OpenCode Go API key (opencode.ai Console → API keys): ");
    expect((await login.account("oc_sk_2")).id).toBe("key-01020304");
    expect([transport.requests[0]!.url, transport.requests[0]!.headers["authorization"]]).toEqual(["http://gw/zen/go/v1/usage", "Bearer oc_sk_2"]);
    await expect(login.account("oc_sk_3")).rejects.toThrow('opencode-go: the key was refused: HTTP 401 {"type":"error"}');
  });
});
