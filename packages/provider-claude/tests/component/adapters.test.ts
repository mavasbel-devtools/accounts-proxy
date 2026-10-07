import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertAccount, EMPTY_POOL, activeAccount } from "../../../core/src/domain/accounts.ts";
import { InvalidRequestError, ProviderAuthRequiredError, UnsupportedFeatureError, UpstreamError } from "../../../core/src/domain/errors.ts";
import { readAll } from "../../../core/src/domain/wire.ts";
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
} from "../../../../tests/support/fakes.ts";
import { CATALOG_KEY, ClaudeCatalog } from "../../src/adapters/outbound/claude-catalog.ts";
import { ClaudeIdentity, DEVICE_ID_KEY } from "../../src/adapters/outbound/claude-identity.ts";
import { ClaudeOAuthClient, PRODUCTION_ENDPOINTS } from "../../src/adapters/outbound/claude-oauth-client.ts";
import { ClaudeSession, REFRESH_LOCK } from "../../src/adapters/outbound/claude-session.ts";
import { ClaudeSubscriptionProvider, forwardedResponseHeaders } from "../../src/adapters/outbound/claude-subscription-provider.ts";
import { CLAUDEAI_SUCCESS_URL, CONSOLE_SUCCESS_URL, TOKEN_HEADERS } from "../../src/domain/constants.ts";
import { fromAccount, toAccount, type ClaudeTokens } from "../../src/domain/credential.ts";
import { STATIC_CATALOG } from "../../src/domain/model-envelope.ts";
import { ClaudeCatalogPort, ClaudeOAuthPort, ClaudeSessionPort } from "../../src/ports/outbound/claude.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-6292741");
const text = (name: string) => readFileSync(join(fixtures, name), "utf8");
const json = <T>(name: string): T => JSON.parse(text(name)) as T;
const ok = (body: unknown): ScriptedResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("ClaudeOAuthClient", () => {
  const clock = new FixedClock(1_000);

  test("authorize URL: official parameter order; matches the captured authorize except redirect/state/challenge/scope", () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock);
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
    expect(client.usesPkce).toBe(true);
    expect(client.manualRedirectUri).toBe("https://platform.claude.com/oauth/code/callback");
    expect(new URL(client.authorizeUrl({ redirectUri: "r", state: "s" })).searchParams.get("code_challenge")).toBe("");
  });

  test("exchange posts the official body with captured headers and returns an account", async () => {
    const transport = new ScriptedTransport(() => ok(json("refresh-response.json")));
    const client = new ClaudeOAuthClient(transport, clock);
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

  test("exchange without a verifier is refused before any request", async () => {
    const transport = new ScriptedTransport(() => ok({}));
    await expect(new ClaudeOAuthClient(transport, clock).exchange({ code: "c", state: "s", redirectUri: "r" })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(transport.requests).toHaveLength(0);
  });

  test("success redirect without user:inference goes to the console page; unreadable account too", () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock);
    expect(client.successRedirect(toAccount({ accessToken: "a", expiresAt: 1, scopes: "org:create_api_key user:profile" }))).toBe(CONSOLE_SUCCESS_URL);
    expect(client.successRedirect({ provider: "claude-subscription", id: "x", label: "x", data: {} })).toBe(CONSOLE_SUCCESS_URL);
  });

  test("refresh body equals the captured refresh request (stored scopes verbatim), and default scopes when none stored", async () => {
    const transport = new ScriptedTransport(() => ok({ access_token: "new", expires_in: 60 }));
    const client = new ClaudeOAuthClient(transport, clock);
    const capturedScope = json<{ scope: string }>("refresh-request.json").scope;
    const fresh = await client.refresh({ accessToken: "old", refreshToken: "sk-ant-oat01-REDACTED", expiresAt: 0, scopes: capturedScope, email: "e" });
    expect(JSON.parse(transport.requests[0]!.body!)).toEqual(json("refresh-request.json"));
    expect(fresh).toEqual({ accessToken: "new", refreshToken: "sk-ant-oat01-REDACTED", expiresAt: 61_000, scopes: capturedScope, email: "e" });
    await client.refresh({ accessToken: "old", refreshToken: "r", expiresAt: 0, scopes: "" });
    expect(JSON.parse(transport.requests[1]!.body!).scope).toBe("user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins");
  });

  test("refresh without a refresh token is an auth error", async () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ok({})), clock);
    await expect(client.refresh({ accessToken: "a", expiresAt: 0, scopes: "" })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });

  test.each([
    [400, ProviderAuthRequiredError],
    [401, ProviderAuthRequiredError],
    [500, UpstreamError],
    [302, UpstreamError],
  ])("token endpoint HTTP %p -> %p", async (status, kind) => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ({ status, body: '{"error":"invalid_grant"}' })), clock);
    await expect(client.refresh({ accessToken: "a", refreshToken: "r", expiresAt: 0, scopes: "s" })).rejects.toBeInstanceOf(kind);
  });

  test("non-JSON 200 is an upstream error", async () => {
    const client = new ClaudeOAuthClient(new ScriptedTransport(() => ({ status: 200, body: "<html>" })), clock);
    await expect(client.refresh({ accessToken: "a", refreshToken: "r", expiresAt: 0, scopes: "s" })).rejects.toThrow("non-JSON");
  });
});

class StubOAuth extends ClaudeOAuthPort {
  readonly provider = "claude-subscription";
  readonly callbackPath = "/callback";
  readonly usesPkce = true;
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
    if (stored) store.pools.set("claude-subscription", upsertAccount(EMPTY_POOL, toAccount(stored)));
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
    const saved = activeAccount(await store.load("claude-subscription"))!;
    expect(saved.id).toBe("me@x");
    expect(fromAccount(saved)?.accessToken).toBe("SECRET-rotated");
    expect(logger.lines).toEqual(["INFO claude-subscription: access token rotated for account me@x"]);
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
    lock.onAcquire = () => store.save("claude-subscription", upsertAccount(EMPTY_POOL, toAccount(tokens(9_000_000, { accessToken: "other-process" }))));
    expect((await session.freshTokens()).accessToken).toBe("other-process");
    expect(oauth.calls).toBe(0);
  });

  test("a failed refresh propagates and the next call retries", async () => {
    let fail = true;
    const { session, oauth } = setup(tokens(0), async (t) => {
      if (fail) throw new ProviderAuthRequiredError("claude-subscription", "rejected");
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
    store.pools.set("claude-subscription", upsertAccount(EMPTY_POOL, { provider: "claude-subscription", id: "bad", label: "bad", data: { x: 1 } }));
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
      "WARN claude-subscription: catalog cache unreadable: Error: EACCES",
      "WARN claude-subscription: catalog cache write failed: Error: ENOSPC",
    ]);
  });

  test("default api base; pages without data; entries without id are skipped", async () => {
    const transport = new ScriptedTransport((_r, i) => ok(i === 0 ? { has_more: true, last_id: "c" } : { data: [{}, { id: "only" }] }));
    const catalog = new ClaudeCatalog(transport, new FixedSession(), new MemoryKeyValueStore(), new FixedClock(), new MemoryLogger());
    expect((await catalog.entries()).map((e) => e.id)).toEqual(["only"]);
    expect(transport.requests[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
  });

  test("a non-Error rejection is still logged", async () => {
    const { catalog, logger } = make(() => Promise.reject("boom"));
    expect(await catalog.entries()).toBe(STATIC_CATALOG);
    expect(logger.lines[0]).toBe("WARN claude-subscription: live catalog unavailable (boom)");
  });
});

class FixedCatalog extends ClaudeCatalogPort {
  async entries() {
    return STATIC_CATALOG;
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
  const raw = (body: unknown, path = "/v1/messages") => ({ path, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("identity and capabilities", async () => {
    const { provider } = make(ok({}));
    expect(provider.id).toBe("claude-subscription");
    expect(provider.nativeDialect).toBe("anthropic");
    expect(provider.capabilities().size).toBe(0);
  });

  test("models come from the catalog with limits", async () => {
    const { provider } = make(ok({}));
    const models = await provider.models();
    expect(models[0]).toEqual({ address: { provider: "claude-subscription", model: "claude-opus-5" }, displayName: "Claude Opus 5", contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  });

  test("models without limits omit them", async () => {
    class Bare extends ClaudeCatalogPort {
      async entries() {
        return [{ id: "x", displayName: "X", createdAt: "", maxInputTokens: 0, maxTokens: 0 }];
      }
    }
    const provider = new ClaudeSubscriptionProvider(new FixedSession(), new Bare(), new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom()), new ScriptedTransport(() => ok({})), new SequenceRandom(), new MemoryLogger());
    expect(await provider.models()).toEqual([{ address: { provider: "claude-subscription", model: "x" }, displayName: "X" }]);
  });

  test("translated cells are not available before P5", async () => {
    const { provider } = make(ok({}));
    const request = { model: { provider: "claude-subscription" as const, model: "m" }, system: [], messages: [], tools: [], params: {}, stream: true };
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
    const response = await provider.passthrough("claude-opus-4-8", raw({ model: "claude-subscription/claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }));
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
      "INFO claude-subscription: stream end model=claude-opus-4-8 stop_reason=refusal",
      "WARN claude-subscription: upstream refusal (model=claude-opus-4-8)",
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
    const provider = new ClaudeSubscriptionProvider(new NoUuid(), new FixedCatalog(), new ClaudeIdentity(new MemoryKeyValueStore(), new SequenceRandom()), transport, new SequenceRandom(), new MemoryLogger());
    await provider.passthrough("m", raw({ messages: [] }));
    expect(transport.requests[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(JSON.parse(JSON.parse(transport.requests[0]!.body!).metadata.user_id).account_uuid).toBe("");
  });

  test("a response without content-type is not observed", async () => {
    const { provider } = make({ status: 200, body: "plain" });
    const response = await provider.passthrough("m", raw({ messages: [] }));
    expect(await readAll(response.body)).toBe("plain");
  });
});
