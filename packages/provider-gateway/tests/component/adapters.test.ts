import { describe, expect, test } from "bun:test";
import { upsertAccount, EMPTY_POOL } from "@inference-router/core/domain/accounts.ts";
import { apiKeyAccount } from "@inference-router/core/domain/api-key.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { JsonValue } from "@inference-router/core/domain/json.ts";
import type { RawRequest } from "@inference-router/core/domain/wire.ts";
import { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { GatewayCatalog } from "@inference-router/provider-gateway/adapters/outbound/gateway-catalog.ts";
import { GatewayKeyLogin, type KeyIdentity } from "@inference-router/provider-gateway/adapters/outbound/gateway-key-login.ts";
import { GatewayKeySession } from "@inference-router/provider-gateway/adapters/outbound/gateway-key-session.ts";
import { GatewayProvider } from "@inference-router/provider-gateway/adapters/outbound/gateway-provider.ts";
import { CATALOG_TTL_MS, type GatewayModel, type GatewaySpec } from "@inference-router/provider-gateway/domain/gateway.ts";
import { GatewayCatalogPort, GatewayCatalogSourcePort, type GatewayListing } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";
import { collect, FixedClock, MemoryCredentialStore, MemoryKeyValueStore, MemoryLogger, ScriptedTransport } from "@inference-router/test-support/fakes.ts";

const SPEC: GatewaySpec = {
  provider: "cheaper-inference",
  apiBase: "http://gw/v1",
  endpoints: { "openai-chat": { path: "/chat/completions" }, "anthropic-messages": { path: "/messages" } },
  requestIdHeader: "x-ci-request-id",
};

function storeWithKey(key = "ci_live_1") {
  const store = new MemoryCredentialStore();
  store.seed("cheaper-inference", upsertAccount(EMPTY_POOL, apiKeyAccount("cheaper-inference", "me@x", "Team", key)));
  return store;
}

describe("GatewayKeySession", () => {
  test("the active account's key; no account: login required (active) or undefined (optionalKey)", async () => {
    const session = new GatewayKeySession("cheaper-inference", storeWithKey());
    expect((await session.active()).key).toBe("ci_live_1");
    expect(await session.optionalKey()).toBe("ci_live_1");
    const empty = new GatewayKeySession("cheaper-inference", new MemoryCredentialStore());
    await expect(empty.active()).rejects.toThrow("cheaper-inference: no active account; run `inference-router login cheaper-inference`");
    expect(await empty.optionalKey()).toBeUndefined();
  });
});

class Source extends GatewayCatalogSourcePort {
  keys: (string | undefined)[] = [];
  constructor(private readonly answer: () => readonly GatewayModel[]) {
    super();
  }
  async fetch(key: string | undefined) {
    this.keys.push(key);
    return this.answer();
  }
}

const BUILTIN: GatewayModel[] = [{ id: "builtin", displayName: "Builtin" }];
const LIVE: GatewayModel[] = [{ id: "live", displayName: "Live", formats: ["openai-chat"] }];
const LIVE_JSON = LIVE as unknown as JsonValue;

describe("GatewayCatalog (rule G5)", () => {
  const make = (answer: () => readonly GatewayModel[], store = new MemoryKeyValueStore()) => {
    const clock = new FixedClock();
    const logger = new MemoryLogger();
    const source = new Source(answer);
    const catalog = new GatewayCatalog("cheaper-inference", source, new GatewayKeySession("cheaper-inference", storeWithKey()), store, clock, logger, BUILTIN);
    return { catalog, clock, logger, source, store };
  };

  test("live (with the key), then memory within 24 h, then a refresh", async () => {
    const { catalog, clock, source, store } = make(() => LIVE);
    expect(await catalog.listing()).toEqual({ source: "live", models: LIVE });
    expect(source.keys).toEqual(["ci_live_1"]);
    expect(store.values.get("cheaper-inference/model-catalog") as unknown).toEqual({ version: 2, fetchedAt: clock.time, models: LIVE });
    expect(await catalog.listing()).toEqual({ source: "live", models: LIVE });
    expect(source.keys).toHaveLength(1);
    clock.time += CATALOG_TTL_MS;
    await catalog.listing();
    expect(source.keys).toHaveLength(2);
  });

  test("a fresh stored copy is used without a fetch; a stale one is the fallback when the live list fails", async () => {
    const store = new MemoryKeyValueStore();
    store.values.set("cheaper-inference/model-catalog", { version: 2, fetchedAt: 1_800_000_000_000, models: LIVE_JSON });
    expect(await make(() => [], store).catalog.listing()).toEqual({ source: "cache", models: LIVE });
    store.values.set("cheaper-inference/model-catalog", { version: 2, fetchedAt: 1, models: LIVE_JSON });
    const failing = make(() => {
      throw new Error("down");
    }, store);
    expect(await failing.catalog.listing()).toEqual({ source: "cache", models: LIVE });
    expect(failing.logger.lines).toEqual(["WARN cheaper-inference: live model list unavailable (down)"]);
  });

  test("an empty live list is shown as answered; no copy and a failing source give the built-in list; a failed cache write is only warned", async () => {
    expect(await make(() => []).catalog.listing()).toEqual({ source: "live", models: [] });
    const failing = make(() => {
      throw new Error("down");
    });
    expect(await failing.catalog.listing()).toEqual({ source: "static", models: BUILTIN });
    const store = new MemoryKeyValueStore();
    store.failRead = new Error("EACCES");
    store.failWrite = new Error("EROFS");
    const broken = make(() => LIVE, store);
    expect(await broken.catalog.listing()).toEqual({ source: "live", models: LIVE });
    expect(broken.logger.lines).toEqual(["WARN cheaper-inference: model list cache unreadable: Error: EACCES", "WARN cheaper-inference: model list cache write failed: Error: EROFS"]);
  });
});

class FixedListing extends GatewayCatalogPort {
  constructor(private readonly models: readonly GatewayModel[]) {
    super();
  }
  async listing(): Promise<GatewayListing> {
    return { source: "live", models: this.models };
  }
}

describe("GatewayProvider", () => {
  const MODELS: GatewayModel[] = [
    { id: "chat-only", displayName: "Chat", contextWindow: 10, maxOutputTokens: 5, createdAt: "2026-10-12T00:00:00.000Z", formats: ["openai-chat", "openai-responses"] },
    { id: "unknown", displayName: "Unknown" },
  ];
  const raw = (fields: Partial<RawRequest> = {}): RawRequest => ({ format: "openai-chat", path: "/v1/chat/completions", query: {}, headers: {}, body: '{"model":"cheaper-inference/chat-only"}', lossy: false, ...fields });
  const make = (spec: GatewaySpec = SPEC, store = storeWithKey()) => {
    const transport = new ScriptedTransport(() => ({ status: 200, headers: { "content-type": "text/event-stream", "x-ci-request-id": "r1", "set-cookie": "s" }, body: ["data: 1\n\n", "data: 2\n\n"] }));
    const logger = new MemoryLogger();
    const provider = new GatewayProvider(spec, new GatewayKeySession(spec.provider, store), new FixedListing(MODELS), transport, logger);
    return { provider, transport, logger };
  };

  test("formats per model from the catalog (filtered to the vendor's endpoints), uniform formats, or unknown", async () => {
    const { provider } = make();
    expect(provider.id).toBe("cheaper-inference");
    expect([...(await provider.nativeFormats("chat-only"))!]).toEqual(["openai-chat"]);
    expect(await provider.nativeFormats("unknown")).toBeUndefined();
    expect(await provider.nativeFormats("absent")).toBeUndefined();
    const uniform = make({ ...SPEC, uniformFormats: ["openai-chat", "anthropic-messages"] }).provider;
    expect([...(await uniform.nativeFormats("anything"))!]).toEqual(["openai-chat", "anthropic-messages"]);
  });

  test("models: the catalog with the served formats; no translated features yet", async () => {
    const { provider } = make();
    expect(await provider.models()).toEqual({
      provider: "cheaper-inference",
      formats: [],
      source: "live",
      models: [
        { address: { provider: "cheaper-inference", model: "chat-only" }, displayName: "Chat", contextWindow: 10, maxOutputTokens: 5, createdAt: "2026-10-12T00:00:00.000Z", formats: ["openai-chat"] },
        { address: { provider: "cheaper-inference", model: "unknown" }, displayName: "Unknown" },
      ],
    });
    expect((await make({ ...SPEC, uniformFormats: ["openai-chat"] }).provider.models()).formats).toEqual(["openai-chat"]);
  });

  test("passthrough: the vendor endpoint, the bare model, the key header, the client's signal; the stream unchanged (G1–G3)", async () => {
    const { provider, transport, logger } = make();
    const signal = new AbortController().signal;
    const response = await provider.passthrough("chat-only", raw({ signal }));
    expect([response.status, response.headers]).toEqual([200, { "content-type": "text/event-stream", "x-ci-request-id": "r1" }]);
    expect(await collect(response.body)).toEqual(["data: 1\n\n", "data: 2\n\n"]);
    const sent = transport.requests[0]!;
    expect([sent.method, sent.url, sent.headers, sent.body, sent.signal]).toEqual(["POST", "http://gw/v1/chat/completions", { "content-type": "application/json", authorization: "Bearer ci_live_1" }, '{"model":"chat-only"}', signal]);
    expect(logger.lines).toEqual(["INFO cheaper-inference: openai-chat model=chat-only -> HTTP 200"]);
    await provider.passthrough("m", raw({ format: "anthropic-messages", path: "/v1/messages" }));
    expect([transport.requests[1]!.headers["authorization"], transport.requests[1]!.headers["x-api-key"]]).toEqual(["Bearer ci_live_1", undefined]);
  });

  test("passthrough without an account needs a login, and nothing is sent", async () => {
    const { provider, transport } = make(SPEC, new MemoryCredentialStore());
    await expect(provider.passthrough("chat-only", raw())).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(transport.requests).toHaveLength(0);
  });
});

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([1, 2, 3, 4, 5]);
  }
}

class Login extends GatewayKeyLogin {
  readonly provider = "opencode";
  readonly question = "key: ";
  constructor(private readonly identity: KeyIdentity) {
    super(new Hash());
  }
  protected async identify(key: string) {
    if (key === "refused") throw new ProviderAuthRequiredError("opencode", "the key was refused");
    return this.identity;
  }
}

describe("GatewayKeyLogin", () => {
  test("the vendor's identity, else the key-hash id; the key is trimmed and stored", async () => {
    const none = { id: undefined, label: undefined };
    expect(await new Login({ id: "me@x", label: "Team" }).account(" k1 ")).toEqual({ provider: "opencode", id: "me@x", label: "Team", data: { apiKey: "k1" } });
    expect(await new Login({ id: "me@x", label: undefined }).account("k1")).toEqual({ provider: "opencode", id: "me@x", label: "me@x", data: { apiKey: "k1" } });
    expect(await new Login(none).account("k1")).toEqual({ provider: "opencode", id: "key-01020304", label: "key-01020304", data: { apiKey: "k1" } });
    await expect(new Login(none).account("refused")).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    await expect(new Login(none).account("  ")).rejects.toThrow("opencode: no API key entered");
  });
});
