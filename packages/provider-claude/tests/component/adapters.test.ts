import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertAccount, EMPTY_POOL, activeAccount } from "@inference-router/core/domain/accounts.ts";
import { InvalidRequestError, ProviderAuthRequiredError, UnsupportedFeatureError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import { readAll, type RawRequest } from "@inference-router/core/domain/wire.ts";
import {
  collect,
  FixedClock,
  MemoryCredentialStore,
  MemoryKeyValueStore,
  MemoryLogger,
  RecordingLock,
  ScriptedTransport,
  SequenceRandom,
  type ScriptedResponse,
} from "@inference-router/test-support/fakes.ts";
import { CATALOG_KEY, ClaudeCatalog } from "@inference-router/provider-claude/adapters/outbound/claude-catalog.ts";
import { ClaudeIdentity, DEVICE_ID_KEY } from "@inference-router/provider-claude/adapters/outbound/claude-identity.ts";
import { ClaudeOAuthClient, PRODUCTION_ENDPOINTS } from "@inference-router/provider-claude/adapters/outbound/claude-oauth-client.ts";
import { API_BASE } from "@inference-router/provider-claude/domain/constants.ts";
import { ClaudeSession, REFRESH_LOCK } from "@inference-router/provider-claude/adapters/outbound/claude-session.ts";
import { ClaudeSubscriptionProvider, forwardedResponseHeaders } from "@inference-router/provider-claude/adapters/outbound/claude-subscription-provider.ts";
import { CLAUDEAI_SUCCESS_URL, CONSOLE_SUCCESS_URL, TOKEN_HEADERS } from "@inference-router/provider-claude/domain/constants.ts";
import { fromAccount, toAccount, type ClaudeTokens } from "@inference-router/provider-claude/domain/credential.ts";
import { STATIC_CATALOG } from "@inference-router/provider-claude/domain/model-envelope.ts";
import { capturedBetaHeader } from "@inference-router/provider-claude/domain/request-transform.ts";
import { ClaudeCatalogPort, ClaudeOAuthPort, ClaudeSessionPort } from "@inference-router/provider-claude/ports/outbound/claude.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-6292741");
const text = (name: string) => readFileSync(join(fixtures, name), "utf8");
const json = <T>(name: string): T => JSON.parse(text(name)) as T;
const ok = (body: unknown): ScriptedResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("ClaudeOAuthClient", () => {
  const clock = new FixedClock(1_000);

  test("authorize URL: official parameter order; matches the captured authorize except redirect/state/challenge/scope", () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock, PRODUCTION_ENDPOINTS);
    const url = new URL(client.authorizeUrl({ redirectUri: "http://localhost:5555/callback", state: "st", codeChallenge: "ch" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.com/cai/oauth/authorize");
    expect([...url.searchParams.keys()]).toEqual(["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"]);
    const captured = json<Record<string, string>>("authorize-params.json");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5555/callback");
    expect(url.searchParams.get("scope")).toBe(`${captured.scope} user:plugins`);
    for (const key of ["code", "client_id", "response_type", "code_challenge_method"]) expect(url.searchParams.get(key)).toBe(captured[key]!);
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(client.callbackPath).toBe("/callback");
    expect(client.manualRedirectUri).toBe("https://platform.claude.com/oauth/code/callback");
  });

  test("exchange posts the official body with captured headers and returns an account", async () => {
    const transport = new ScriptedTransport(() => ok(json("refresh-response.json")));
    const client = new ClaudeOAuthClient(transport, clock, PRODUCTION_ENDPOINTS);
    const account = await client.exchange({ code: "c0de", state: "st", redirectUri: "http://localhost:5555/callback", codeVerifier: "ver" });
    const sent = transport.requests[0]!;
    expect(sent.url).toBe(PRODUCTION_ENDPOINTS.tokenUrl);
    expect(sent.headers).toEqual(TOKEN_HEADERS);
    expect(JSON.parse(sent.body!)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: "http://localhost:5555/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: "ver",
      state: "st",
    });
    expect(Object.keys(JSON.parse(sent.body!))).toEqual(["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "state"]);
    expect(account.id).toBe("<account-email>");
    expect(fromAccount(account)?.expiresAt).toBe(1_000 + 28_800_000);
    expect(client.successRedirect(account)).toBe(CLAUDEAI_SUCCESS_URL);
  });


  test("success redirect without user:inference goes to the console page; unreadable account too", () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock, PRODUCTION_ENDPOINTS);
    expect(client.successRedirect(toAccount({ accessToken: "a", expiresAt: 1, scopes: "org:create_api_key user:profile" }))).toBe(CONSOLE_SUCCESS_URL);
    expect(client.successRedirect({ provider: "claude", id: "x", label: "x", data: {} })).toBe(CONSOLE_SUCCESS_URL);
  });

  test("refresh body equals the captured refresh request (stored scopes verbatim), and default scopes when none stored", async () => {
    const transport = new ScriptedTransport(() => ok({ access_token: "new", expires_in: 60 }));
    const client = new ClaudeOAuthClient(transport, clock, PRODUCTION_ENDPOINTS);
    const capturedScope = json<{ scope: string }>("refresh-request.json").scope;
    const fresh = await client.refresh({ accessToken: "old", refreshToken: "sk-ant-oat01-REDACTED", expiresAt: 0, scopes: capturedScope, email: "e" });
    expect(JSON.parse(transport.requests[0]!.body!)).toEqual(json("refresh-request.json"));
    expect(fresh).toEqual({ accessToken: "new", refreshToken: "sk-ant-oat01-REDACTED", expiresAt: 61_000, scopes: capturedScope, email: "e" });
    await client.refresh({ accessToken: "old", refreshToken: "r", expiresAt: 0, scopes: "" });
    expect(JSON.parse(transport.requests[1]!.body!).scope).toBe("user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins");
  });

  test("refresh without a refresh token is an auth error", async () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock, PRODUCTION_ENDPOINTS);
    await expect(client.refresh({ accessToken: "a", expiresAt: 0, scopes: "" })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });

  test.each([
    [400, ProviderAuthRequiredError],
    [401, ProviderAuthRequiredError],
    [500, UpstreamError],
    [302, UpstreamError],
  ])("token endpoint HTTP %p -> %p", async (status, kind) => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ({ status, body: '{"error":"invalid_grant"}' })), clock, PRODUCTION_ENDPOINTS);
    await expect(client.refresh({ accessToken: "a", refreshToken: "r", expiresAt: 0, scopes: "s" })).rejects.toBeInstanceOf(kind);
  });

  test("non-JSON 200 is an upstream error", async () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ({ status: 200, body: "<html>" })), clock, PRODUCTION_ENDPOINTS);
    await expect(client.refresh({ accessToken: "a", refreshToken: "r", expiresAt: 0, scopes: "s" })).rejects.toThrow("non-JSON");
  });
});

class StubOAuth extends ClaudeOAuthPort {
  readonly provider = "claude";
  readonly callbackPath = "/callback";
  readonly manualRedirectUri = undefined;
  calls = 0;
  constructor(private readonly result: (tokens: ClaudeTokens) => Promise<ClaudeTokens>) {
    super();
  }
  authorizeUrl(): string {
    return "";
  }
  async exchange(): Promise<never> {
    throw new Error("unused");
  }
  successRedirect(): string {
    return "";
  }
  refresh(tokens: ClaudeTokens): Promise<ClaudeTokens> {
    this.calls += 1;
    return this.result(tokens);
  }
}

describe("ClaudeSession", () => {
  const tokens = (expiresAt: number, extra: Partial<ClaudeTokens> = {}): ClaudeTokens => ({ accessToken: `at-${expiresAt}`, refreshToken: "SECRET-rt", expiresAt, scopes: "s", email: "me@x", ...extra });
  const setup = (stored: ClaudeTokens | undefined, refresh = (t: ClaudeTokens) => Promise.resolve({ ...t, accessToken: "SECRET-rotated", expiresAt: 10_000_000 })) => {
    const store = new MemoryCredentialStore();
    if (stored) store.pools.set("claude", upsertAccount(EMPTY_POOL, toAccount(stored)));
    const oauth = new StubOAuth(refresh);
    const lock = new RecordingLock();
    const logger = new MemoryLogger();
    const session = new ClaudeSession(store, oauth, lock, new FixedClock(1_000_000), logger);
    return { store, oauth, lock, logger, session };
  };

  test("a valid token is returned without locking or refreshing", async () => {
    const { session, oauth, lock } = setup(tokens(5_000_000));
    expect((await session.freshTokens()).accessToken).toBe("at-5000000");
    expect(oauth.calls).toBe(0);
    expect(lock.acquired).toEqual([]);
  });

  test("an expiring token is refreshed under the lock, saved under the same account id, and logged without secrets", async () => {
    const { session, store, lock, logger } = setup(tokens(1_000_000 + 60_000));
    expect((await session.freshTokens()).accessToken).toBe("SECRET-rotated");
    expect(lock.acquired).toEqual([REFRESH_LOCK]);
    const saved = activeAccount(await store.load("claude"))!;
    expect(saved.id).toBe("me@x");
    expect(fromAccount(saved)?.accessToken).toBe("SECRET-rotated");
    expect(logger.lines).toEqual(["INFO claude: access token rotated for account me@x"]);
    expect(logger.lines.join("\n")).not.toContain("SECRET");
  });

  test("concurrent callers share one refresh (single flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { session, oauth } = setup(tokens(0), async (t) => {
      await gate;
      return { ...t, accessToken: "SECRET-rotated", expiresAt: 10_000_000 };
    });
    const all = Promise.all([session.freshTokens(), session.freshTokens(), session.freshTokens()]);
    await Bun.sleep(5);
    release();
    expect((await all).map((t) => t.accessToken)).toEqual(["SECRET-rotated", "SECRET-rotated", "SECRET-rotated"]);
    expect(oauth.calls).toBe(1);
  });

  test("a refresh completed by another process while waiting for the lock is reused", async () => {
    const { session, store, oauth, lock } = setup(tokens(0));
    lock.onAcquire = () => store.save("claude", upsertAccount(EMPTY_POOL, toAccount(tokens(9_000_000, { accessToken: "other-process" }))));
    expect((await session.freshTokens()).accessToken).toBe("other-process");
    expect(oauth.calls).toBe(0);
  });

  test("a failed refresh propagates and the next call retries", async () => {
    let fail = true;
    const { session, oauth } = setup(tokens(0), async (t) => {
      if (fail) throw new ProviderAuthRequiredError("claude", "rejected");
      return { ...t, accessToken: "SECRET-rotated", expiresAt: 10_000_000 };
    });
    await expect(session.freshTokens()).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    fail = false;
    expect((await session.freshTokens()).accessToken).toBe("SECRET-rotated");
    expect(oauth.calls).toBe(2);
  });

  test("no account / unreadable account", async () => {
    await expect(setup(undefined).session.freshTokens()).rejects.toThrow("no active account");
    const { session, store } = setup(undefined);
    store.pools.set("claude", upsertAccount(EMPTY_POOL, { provider: "claude", id: "bad", label: "bad", data: { x: 1 } }));
    await expect(session.freshTokens()).rejects.toThrow("stored credential of bad is unreadable");
  });
});

describe("ClaudeIdentity", () => {
  test("creates a 64-hex device id once, persists it, and reuses it", async () => {
    const kv = new MemoryKeyValueStore();
    const identity = new ClaudeIdentity(kv, new SequenceRandom());
    const id = await identity.deviceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id.startsWith("000102030405")).toBe(true);
    expect(kv.values.get(DEVICE_ID_KEY)).toBe(id);
    expect(await identity.deviceId()).toBe(id);
    expect(await new ClaudeIdentity(kv, new SequenceRandom()).deviceId()).toBe(id);
  });
  test("replaces a stored value that is not 64 hex (e.g. the plugin's base64url format)", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set(DEVICE_ID_KEY, "AbC-_base64url");
    expect(await new ClaudeIdentity(kv, new SequenceRandom()).deviceId()).toMatch(/^[0-9a-f]{64}$/);
  });
  test("session id per instance; previous message id tracking", () => {
    const identity = new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom());
    expect(identity.sessionId).toBe("uuid-1");
    expect(identity.previousMessageId()).toBeNull();
    identity.setPreviousMessageId("msg_1");
    expect(identity.previousMessageId()).toBe("msg_1");
  });
});

class FixedSession extends ClaudeSessionPort {
  calls = 0;
  async freshTokens(): Promise<ClaudeTokens> {
    this.calls += 1;
    return { accessToken: "at", expiresAt: 0, scopes: "", accountUuid: "acct-1" };
  }
}

describe("ClaudeCatalog", () => {
  const live = json<{ data: unknown[] }>("catalog-api-response.json");
  const make = (handler: ConstructorParameters<typeof ScriptedTransport>[0], kv = new MemoryKeyValueStore(), clock = new FixedClock(100_000_000)) => {
    const transport = new ScriptedTransport(handler);
    const logger = new MemoryLogger();
    return { transport, kv, logger, clock, catalog: new ClaudeCatalog(transport, new FixedSession(), kv, clock, logger, "http://up") };
  };

  test("fetches live (contract headers, limit, timeout), caches in memory and on disk", async () => {
    const { catalog, transport, kv } = make(() => ok({ ...live, has_more: false }));
    expect(await catalog.entries()).toEqual([...STATIC_CATALOG]);
    const sent = transport.requests[0]!;
    expect(sent.url).toBe("http://up/v1/models?limit=100");
    expect(sent.headers).toEqual({ authorization: "Bearer at", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(sent.timeoutMs).toBe(3_000);
    expect(kv.values.get(CATALOG_KEY)).toMatchObject({ version: 2, fetchedAt: 100_000_000 });
    await catalog.entries();
    expect(transport.requests).toHaveLength(1);
  });

  test("paginates with last_id, then the last parsed id, and stops after 10 pages", async () => {
    const { catalog, transport } = make((_r, i) => ok({ data: [{ id: `m${i}` }], has_more: true, ...(i === 0 ? { last_id: "cursor-a" } : {}) }));
    const entries = await catalog.entries();
    expect(entries.map((e) => e.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
    expect(transport.requests[1]!.url).toBe("http://up/v1/models?limit=100&after_id=cursor-a");
    expect(transport.requests[2]!.url).toBe("http://up/v1/models?limit=100&after_id=m1");
    expect(transport.requests).toHaveLength(10);
  });

  test("a fresh disk cache is used without any request; a stale one is refreshed", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set(CATALOG_KEY, { version: 2, fetchedAt: 100_000_000 - 1000, models: [{ id: "cached", displayName: "C", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] });
    const fresh = make(() => ok({}), kv);
    expect((await fresh.catalog.entries()).map((e) => e.id)).toEqual(["cached"]);
    expect(fresh.transport.requests).toHaveLength(0);
    const stale = make(() => ok({ data: [{ id: "live" }] }), kv, new FixedClock(100_000_000 + 25 * 3600_000));
    expect((await stale.catalog.entries()).map((e) => e.id)).toEqual(["live"]);
  });

  test("live failure falls back to the stale cache, else to the static minimum; failures are logged", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set(CATALOG_KEY, { version: 2, fetchedAt: 0, models: [{ id: "stale", displayName: "S", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] });
    const withStale = make(() => ({ status: 503, body: "down" }), kv);
    expect((await withStale.catalog.entries()).map((e) => e.id)).toEqual(["stale"]);
    expect(withStale.logger.lines[0]).toContain("models catalog HTTP 503");
    const empty = make(() => ok({ data: [] }));
    expect(await empty.catalog.entries()).toBe(STATIC_CATALOG);
    expect(empty.logger.lines[0]).toContain("live catalog is empty");
  });

  test("unreadable cache and failed cache write are non-fatal", async () => {
    const kv = new MemoryKeyValueStore();
    kv.failRead = new Error("EACCES");
    kv.failWrite = new Error("ENOSPC");
    const { catalog, logger } = make(() => ok({ data: [{ id: "live" }] }), kv);
    expect((await catalog.entries()).map((e) => e.id)).toEqual(["live"]);
    expect(logger.lines).toEqual([
      "WARN claude: catalog cache unreadable: Error: EACCES",
      "WARN claude: catalog cache write failed: Error: ENOSPC",
    ]);
  });

  test("production api base; pages without data; entries without id are skipped", async () => {
    const transport = new ScriptedTransport((_r, i) => ok(i === 0 ? { has_more: true, last_id: "c" } : { data: [{}, { id: "only" }] }));
    const catalog = new ClaudeCatalog(transport, new FixedSession(), new MemoryKeyValueStore(), new FixedClock(), new MemoryLogger(), API_BASE);
    expect((await catalog.entries()).map((e) => e.id)).toEqual(["only"]);
    expect(transport.requests[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
  });

  test("listing reports where the list came from: live (and memoized), disk cache, stale cache, static", async () => {
    const live = make(() => ok({ data: [{ id: "live" }] }));
    expect((await live.catalog.listing()).source).toBe("live");
    expect((await live.catalog.listing()).source).toBe("live");
    expect(live.transport.requests).toHaveLength(1);

    const kv = new MemoryKeyValueStore();
    kv.values.set(CATALOG_KEY, { version: 2, fetchedAt: 100_000_000 - 1000, models: [{ id: "cached", displayName: "C", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] });
    expect((await make(() => ok({}), kv).catalog.listing()).source).toBe("cache");

    const stale = new MemoryKeyValueStore();
    stale.values.set(CATALOG_KEY, { version: 2, fetchedAt: 0, models: [{ id: "stale", displayName: "S", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] });
    expect(await make(() => ({ status: 503, body: "down" }), stale).catalog.listing()).toMatchObject({ source: "cache", entries: [{ id: "stale" }] });

    expect(await make(() => ({ status: 503, body: "down" })).catalog.listing()).toEqual({ source: "static", entries: STATIC_CATALOG });
  });

  test("a transport failure is logged with its message", async () => {
    const { catalog, logger } = make(() => Promise.reject(new TypeError("connection refused")));
    expect(await catalog.entries()).toBe(STATIC_CATALOG);
    expect(logger.lines[0]).toBe("WARN claude: live catalog unavailable (connection refused)");
  });
});

class FixedCatalog extends ClaudeCatalogPort {
  async listing() {
    return { source: "static" as const, entries: STATIC_CATALOG };
  }
}

describe("ClaudeSubscriptionProvider", () => {
  const sse = text("messages-single-response.sse");
  const make = (response: ScriptedResponse | (() => ScriptedResponse)) => {
    const transport = new ScriptedTransport(() => (typeof response === "function" ? response() : response));
    const identity = new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom());
    const logger = new MemoryLogger();
    const provider = new ClaudeSubscriptionProvider(new FixedSession(), new FixedCatalog(), identity, transport, new SequenceRandom(), logger, "http://up");
    return { transport, identity, logger, provider };
  };
  const raw = (body: unknown, path = "/v1/messages", headers: Record<string, string> = {}, lossy = false): RawRequest => ({
    path,
    query: {},
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    lossy,
  });

  test("identity and capabilities", async () => {
    const { provider } = make(ok({}));
    expect(provider.id).toBe("claude");
    expect(provider.nativeDialect).toBe("anthropic");
    expect(provider.capabilities().size).toBe(0);
  });

  test("models come from the catalog with limits", async () => {
    const { provider } = make(ok({}));
    const catalog = await provider.models();
    expect(catalog.provider).toBe("claude");
    expect(catalog.source).toBe("static");
    expect(catalog.models[0]).toEqual({
      address: { provider: "claude", model: "claude-opus-5" },
      displayName: "Claude Opus 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      createdAt: "2026-07-24T00:00:00Z",
    });
  });

  test("models without limits omit them", async () => {
    class Bare extends ClaudeCatalogPort {
      async listing() {
        return { source: "live" as const, entries: [{ id: "x", displayName: "X", createdAt: "", maxInputTokens: 0, maxTokens: 0 }] };
      }
    }
    const provider = new ClaudeSubscriptionProvider(new FixedSession(), new Bare(), new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom()), new ScriptedTransport(() => ok({})), new SequenceRandom(), new MemoryLogger(), API_BASE);
    expect(await provider.models()).toEqual({ provider: "claude", nativeDialect: "anthropic", source: "live", models: [{ address: { provider: "claude", model: "x" }, displayName: "X" }] });
  });

  test("translated cells are not available before P5", async () => {
    const { provider } = make(ok({}));
    const request = { model: { provider: "claude" as const, model: "m" }, system: [], messages: [], tools: [], params: {}, stream: true };
    await expect(provider.countTokens(request)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect((async () => {
      for await (const _ of provider.stream(request)) void _;
    })()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  test.each([
    [raw({ messages: [] }, "/v1/complete"), "no native route"],
    [raw("{not json"), "not valid JSON"],
    [raw([1]), "messages array"],
    [raw({ messages: "x" }), "messages array"],
  ])("rejects %p", async (request, message) => {
    const { provider, transport } = make(ok({}));
    await expect(provider.passthrough("claude-opus-4-8", request)).rejects.toThrow(message);
    await expect(provider.passthrough("claude-opus-4-8", request)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(transport.requests).toHaveLength(0);
  });

  test("native passthrough: transformed upstream request; SSE streamed back byte-identical; message id tracked", async () => {
    const parts = [sse.slice(0, 37), sse.slice(37, 700), sse.slice(700)];
    const { provider, transport, identity, logger } = make({ status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "request-id": "req_1", "x-internal": "no" }, body: parts });
    const response = await provider.passthrough("claude-opus-4-8", raw({ model: "claude/claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }));
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/event-stream; charset=utf-8", "request-id": "req_1" });
    expect((await collect(response.body)).join("")).toBe(sse);
    const sent = transport.requests[0]!;
    expect(sent.url).toBe("http://up/v1/messages?beta=true");
    expect(sent.headers.authorization).toBe("Bearer at");
    const body = JSON.parse(sent.body!) as { model: string; metadata: { user_id: string } };
    expect(body.model).toBe("claude-opus-4-8");
    expect(JSON.parse(body.metadata.user_id)).toMatchObject({ account_uuid: "acct-1", session_id: identity.sessionId });
    expect(identity.previousMessageId()).toMatch(/^msg_/);
    expect(logger.lines.at(-1)).toMatch(/stream end model=claude-opus-4-8 stop_reason=/);
  });

  test("F1: the response is streamed incrementally (first chunk arrives before the upstream finishes)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* slow(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_slow"}}\n\n');
      await gate;
      yield new TextEncoder().encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n');
    }
    const { provider, identity, logger } = make({ status: 200, headers: { "content-type": "text/event-stream" }, body: slow });
    const response = await provider.passthrough("claude-opus-4-8", raw({ messages: [{ role: "user", content: "hi" }] }));
    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(new TextDecoder().decode(first.value)).toContain("msg_slow");
    expect(identity.previousMessageId()).toBe("msg_slow");
    release();
    expect((await iterator.next()).done).toBe(false);
    expect((await iterator.next()).done).toBe(true);
    expect(logger.lines.slice(-2)).toEqual([
      "INFO claude: stream end model=claude-opus-4-8 stop_reason=refusal",
      "WARN claude: upstream refusal (model=claude-opus-4-8)",
    ]);
  });

  test("malformed SSE data lines are skipped by the observer, bytes still pass", async () => {
    const body = "data: not-json\n\ndata: {\"type\":\"ping\"}\n\n";
    const { provider } = make({ status: 200, headers: { "content-type": "text/event-stream" }, body });
    const response = await provider.passthrough("m", raw({ messages: [] }));
    expect((await collect(response.body)).join("")).toBe(body);
  });

  test("error and JSON responses pass through unchanged (status, retry-after, body)", async () => {
    const error = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}';
    const { provider } = make({ status: 429, headers: { "content-type": "application/json", "retry-after": "17", "anthropic-ratelimit-requests-remaining": "0" }, body: error });
    const response = await provider.passthrough("m", raw({ messages: [] }, "/v1/messages/count_tokens"));
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ "content-type": "application/json", "retry-after": "17", "anthropic-ratelimit-requests-remaining": "0" });
    expect(await readAll(response.body)).toBe(error);
  });

  test("forwardedResponseHeaders keeps only the allowlist, lower-cased", () => {
    expect(forwardedResponseHeaders({ "Retry-After": "1", "Set-Cookie": "x", "Anthropic-Ratelimit-Tokens-Limit": "9", Server: "s" })).toEqual({ "retry-after": "1", "anthropic-ratelimit-tokens-limit": "9" });
  });

  test("an account without uuid sends an empty account_uuid (source behaviour)", async () => {
    class NoUuid extends ClaudeSessionPort {
      async freshTokens(): Promise<ClaudeTokens> {
        return { accessToken: "at", expiresAt: 0, scopes: "" };
      }
    }
    const transport = new ScriptedTransport(() => ok({}));
    const provider = new ClaudeSubscriptionProvider(new NoUuid(), new FixedCatalog(), new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom()), transport, new SequenceRandom(), new MemoryLogger(), API_BASE);
    await provider.passthrough("m", raw({ messages: [] }));
    expect(transport.requests[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(JSON.parse(JSON.parse(transport.requests[0]!.body!).metadata.user_id).account_uuid).toBe("");
  });

  test("a response without content-type is not observed", async () => {
    const { provider } = make({ status: 200, body: "plain" });
    const response = await provider.passthrough("m", raw({ messages: [] }));
    expect(await readAll(response.body)).toBe("plain");
  });

  const sentBetas = (transport: ScriptedTransport) => transport.requests[0]!.headers["anthropic-beta"];
  const captured = capturedBetaHeader("claude-opus-4-8", (id) => STATIC_CATALOG.find((e) => e.id === id));

  test("F4: no client anthropic-beta sends the captured set unchanged", async () => {
    const { provider, transport } = make(ok({}));
    const response = await provider.passthrough("claude-opus-4-8", raw({ messages: [] }));
    expect(sentBetas(transport)).toBe(captured);
    expect(response.headers["x-router-dropped"]).toBeUndefined();
  });

  test("F4: known client betas go first (client order, deduplicated), then the rest of the captured set", async () => {
    const { provider, transport } = make(ok({}));
    const names = captured.split(",");
    const [a, b] = [names[2]!, names[0]!];
    await provider.passthrough("claude-opus-4-8", raw({ messages: [] }, "/v1/messages", { "anthropic-beta": ` ${a}, ${b},${a},` }));
    expect(sentBetas(transport)!.split(",")).toEqual([a, b, ...names.filter((n) => n !== a && n !== b)]);
  });

  test("F4: an unproven beta is unsupported_feature; lossy drops it and reports it", async () => {
    const strict = make(ok({}));
    const request = raw({ messages: [] }, "/v1/messages", { "anthropic-beta": "files-api-2025-04-14,oauth-2025-04-20" });
    const error = await strict.provider.passthrough("claude-opus-4-8", request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect((error as UnsupportedFeatureError).features).toEqual(["anthropic-beta:files-api-2025-04-14"]);
    expect(strict.transport.requests).toHaveLength(0);

    const lossy = make(ok({}));
    const response = await lossy.provider.passthrough("claude-opus-4-8", { ...request, lossy: true });
    expect(sentBetas(lossy.transport)!.includes("files-api")).toBe(false);
    expect(sentBetas(lossy.transport)!.startsWith("oauth-2025-04-20")).toBe(true);
    expect(response.headers["x-router-dropped"]).toBe("anthropic-beta:files-api-2025-04-14");
  });

  test("anthropic-version: the captured value passes; any other is unsupported_feature, or dropped with lossy", async () => {
    const same = make(ok({}));
    await same.provider.passthrough("m", raw({ messages: [] }, "/v1/messages", { "anthropic-version": "2023-06-01" }));
    expect(same.transport.requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");

    const other = make(ok({}));
    const request = raw({ messages: [] }, "/v1/messages", { "anthropic-version": "2099-01-01", "anthropic-beta": "nope-1" });
    await expect(other.provider.passthrough("m", request)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    const response = await other.provider.passthrough("m", { ...request, lossy: true });
    expect(other.transport.requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(response.headers["x-router-dropped"]).toBe("anthropic-version:2099-01-01,anthropic-beta:nope-1");
  });

  test("the client's abort signal is handed to the transport", async () => {
    const { provider, transport } = make(ok({}));
    const controller = new AbortController();
    await provider.passthrough("m", { ...raw({ messages: [] }), signal: controller.signal });
    expect(transport.requests[0]!.signal).toBe(controller.signal);
  });
});
