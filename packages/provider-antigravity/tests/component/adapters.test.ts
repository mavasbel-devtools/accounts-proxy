import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeAccount, EMPTY_POOL, upsertAccount, TOKEN_ENDPOINT_TIMEOUT_MS } from "@accounts-proxy/core/domain/accounts.ts";
import { InvalidRequestError, ProviderAuthRequiredError, QuotaExhaustedError, UnknownModelError, UnsupportedFeatureError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import type { JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import {
  FixedClock,
  MemoryCredentialStore,
  MemoryKeyValueStore,
  MemoryLogger,
  RecordingLock,
  ScriptedTransport,
  SequenceRandom,
  type ScriptedResponse,
} from "@accounts-proxy/test-support/fakes.ts";
import { AntigravityApiClient } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-api-client.ts";
import { AntigravityCatalog } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-catalog.ts";
import { AntigravityNative, unwrapEnvelope } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-native.ts";
import { AntigravityRunner } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-runner.ts";
import { AntigravityProvider } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-provider.ts";
import { AntigravityQuota } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-quota.ts";
import { AntigravitySession, REFRESH_LOCK } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-session.ts";
import { AntigravityState, SESSION_ID_KEY, SIGNATURES_KEY } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-state.ts";
import { GoogleOAuthClient, PRODUCTION_ENDPOINTS } from "@accounts-proxy/provider-antigravity/adapters/outbound/google-oauth-client.ts";
import { withActive } from "@accounts-proxy/provider-antigravity/adapters/outbound/with-active.ts";
import { fromCredential, toCredential, type AntigravityAccount, type AuthTokens } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import { CLIENT_ID, CLIENT_SECRET, DAILY_HOST, SCOPES, SUCCESS_REDIRECT, USER_AGENT, USERINFO_URL } from "@accounts-proxy/provider-antigravity/domain/constants.ts";
import { toModelDescriptors } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { prepareGeminiRequest } from "@accounts-proxy/provider-antigravity/domain/native-gemini.ts";
import type { GenerateParams } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";
import { OAuthSessionPort } from "@accounts-proxy/core/ports/outbound/session.ts";
import { AntigravityApiPort, AntigravityCatalogPort, AntigravityOAuthPort, AntigravityStatePort, type ActiveAccount } from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-5c6f7c2");
const text = (name: string) => readFileSync(join(fixtures, name), "utf8");
const json = (body: unknown, status = 200): ScriptedResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tokens: AuthTokens = { accessToken: "at", refreshToken: "rt", expiresAt: 9_000_000_000_000 };
const acct = (extra: Partial<AntigravityAccount> = {}): AntigravityAccount => ({ email: "me@x", tokens, projectIds: ["proj-1"], activeProjectId: "proj-1", ...extra });

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("AntigravityApiClient", () => {
  const make = (handler: ConstructorParameters<typeof ScriptedTransport>[0]) => {
    const transport = new ScriptedTransport(handler);
    const logger = new MemoryLogger();
    return { transport, logger, client: new AntigravityApiClient(transport, logger, "http://up", "http://userinfo") };
  };
  const callHeaders = { "content-type": "application/json", authorization: "Bearer at", "user-agent": USER_AGENT };

  test("UA law: every /v1internal call carries the captured user agent; bodies and urls per operation", async () => {
    const { client, transport } = make(() => json({ ok: 1 }));
    expect(await client.loadCodeAssist(tokens)).toEqual({ ok: 1 });
    await client.onboardUser(tokens);
    await client.fetchAvailableModels(tokens);
    await client.retrieveUserQuotaSummary(tokens);
    expect(transport.requests.map((r) => [r.method, r.url, JSON.parse(r.body!)])).toEqual([
      ["POST", "http://up/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }],
      ["POST", "http://up/v1internal:onboardUser", { tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.5.5", ide_name: "antigravity" } }],
      ["POST", "http://up/v1internal:fetchAvailableModels", {}],
      ["POST", "http://up/v1internal:retrieveUserQuotaSummary", {}],
    ]);
    for (const r of transport.requests) expect(r.headers).toEqual(callHeaders);
  });

  test("unparsable or non-object success bodies become {}", async () => {
    for (const body of ["not json", "[1]", "null"]) {
      const { client } = make(() => ({ status: 200, body }));
      expect(await client.fetchAvailableModels(tokens)).toEqual({});
    }
  });

  test("failures: 429 → quota with retry-after, others → upstream error", async () => {
    await expect(make(() => ({ status: 429, headers: { "retry-after": "7" }, body: "RESOURCE_EXHAUSTED" })).client.fetchAvailableModels(tokens)).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(make(() => ({ status: 500, body: "boom" })).client.loadCodeAssist(tokens)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("fetchUserInfo: userSettings email first, else Google userinfo with UA", async () => {
    expect(await make(() => json({ userSettings: { email: "s@x" } })).client.fetchUserInfo(tokens)).toEqual({ email: "s@x" });
    const { client, transport } = make((_r, i) => (i === 0 ? json({ userSettings: null }) : json({ email: "g@x" })));
    expect(await client.fetchUserInfo(tokens)).toEqual({ email: "g@x" });
    expect(transport.requests[1]).toEqual({ method: "GET", url: "http://userinfo", headers: { authorization: "Bearer at", "user-agent": USER_AGENT } });
    expect(await make((_r, i) => (i === 0 ? json({}) : json({ name: "n" }))).client.fetchUserInfo(tokens)).toEqual({});
    await expect(make((_r, i) => (i === 0 ? json({}) : { status: 403, body: "no" })).client.fetchUserInfo(tokens)).rejects.toBeInstanceOf(UpstreamError);
  });

  const params: GenerateParams = { project: "proj-1", requestId: "agent/s/1/t/3", body: { contents: [] }, modelWireId: "gemini-x" };

  test("stream: captured SSE decoded; request envelope, url and header allowlist", async () => {
    const { client, transport } = make(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: [text("stream-generate.sample.sse").slice(0, 50), text("stream-generate.sample.sse").slice(50)] }));
    const envelopes = await drain(client.streamGenerate(params, tokens, undefined));
    expect(envelopes).toHaveLength(3);
    expect(envelopes[2]!.response?.candidates?.[0]?.finishReason).toBe("STOP");
    const sent = transport.requests[0]!;
    expect(sent.url).toBe("http://up/v1internal:streamGenerateContent?alt=sse");
    expect(sent.headers).toEqual({ ...callHeaders, "accept-encoding": "gzip" });
    expect(JSON.parse(sent.body!)).toEqual({ project: "proj-1", requestId: "agent/s/1/t/3", request: { contents: [] }, model: "gemini-x", userAgent: "antigravity", requestType: "agent" });
    expect(sent.signal).toBeUndefined();
    const controller = new AbortController();
    await drain(client.streamGenerate(params, tokens, controller.signal));
    expect(transport.requests[1]!.signal).toBe(controller.signal);
  });

  test("stream: [DONE] and empty data skipped, malformed events dropped with a warning, non-response payload throws", async () => {
    const body = 'data: [DONE]\n\ndata:\n\ndata: {bad\n\ndata: {"response":{}}\n\n';
    const { client, logger } = make(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, body }));
    expect(await drain(client.streamGenerate(params, tokens, undefined))).toEqual([{ response: {} }]);
    expect(logger.lines[0]).toContain("dropping malformed SSE event");
    const bad = make(() => ({ status: 200, body: 'data: {"error":{"code":429}}\n\n' }));
    await expect(drain(bad.client.streamGenerate(params, tokens, undefined))).rejects.toThrow("non-response payload");
  });

  test("stream: JSON transport (single, array with non-object, malformed) and HTTP failure", async () => {
    expect(await drain(make(() => json({ response: { responseId: "1" } })).client.streamGenerate(params, tokens, undefined))).toEqual([{ response: { responseId: "1" } }]);
    const arr = make(() => ({ status: 200, headers: { "content-type": "Application/JSON; charset=utf-8" }, body: '[{"response":{}}, 3]' }));
    expect(await drain(arr.client.streamGenerate(params, tokens, undefined))).toEqual([{ response: {} }]);
    expect(arr.logger.lines[0]).toContain("non-object JSON stream envelope (number)");
    await expect(drain(make(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{oops" })).client.streamGenerate(params, tokens, undefined))).rejects.toThrow("malformed JSON stream body");
    await expect(drain(make(() => ({ status: 400, body: "User location is not supported" })).client.streamGenerate(params, tokens, undefined))).rejects.toBeInstanceOf(UpstreamError);
  });

  test("production hosts: daily host and Google userinfo", async () => {
    const transport = new ScriptedTransport((_r, i) => (i === 0 ? json({}) : json({})));
    const client = new AntigravityApiClient(transport, new MemoryLogger(), DAILY_HOST, USERINFO_URL);
    await client.fetchUserInfo(tokens);
    expect(transport.requests.map((r) => r.url)).toEqual(["https://daily-cloudcode-pa.googleapis.com/v1internal:fetchUserInfo", "https://www.googleapis.com/oauth2/v2/userinfo"]);
  });
});

class ScriptedApi extends AntigravityApiPort {
  calls: string[] = [];
  streams: GenerateParams[] = [];
  userInfo: () => Promise<{ email?: string }> = async () => ({ email: "me@x" });
  codeAssist: () => Promise<Record<string, unknown>> = async () => ({ cloudaicompanionProject: "proj-1" });
  onboard: () => Promise<Record<string, unknown>> = async () => ({ response: { cloudaicompanionProject: { id: "onboarded" } } });
  models: (t: AuthTokens) => Promise<Record<string, unknown>> = async () => JSON.parse(text("fetch-available-models.sample.json")) as Record<string, unknown>;
  quota: () => Promise<Record<string, unknown>> = async () => JSON.parse(text("retrieve-user-quota-summary.sample.json")) as Record<string, unknown>;
  stream: (p: GenerateParams, t: AuthTokens, call: number) => AsyncIterable<StreamEnvelope> = async function* () {};
  loadCodeAssist() {
    this.calls.push("loadCodeAssist");
    return this.codeAssist();
  }
  onboardUser() {
    this.calls.push("onboardUser");
    return this.onboard();
  }
  fetchUserInfo() {
    this.calls.push("fetchUserInfo");
    return this.userInfo();
  }
  fetchAvailableModels(t: AuthTokens) {
    this.calls.push("fetchAvailableModels");
    return this.models(t);
  }
  retrieveUserQuotaSummary() {
    this.calls.push("retrieveUserQuotaSummary");
    return this.quota();
  }
  signals: (AbortSignal | undefined)[] = [];
  streamGenerate(p: GenerateParams, t: AuthTokens, signal?: AbortSignal) {
    this.signals.push(signal);
    this.streams.push(p);
    return this.stream(p, t, this.streams.length);
  }
}

describe("GoogleOAuthClient", () => {
  const make = (handler: ConstructorParameters<typeof ScriptedTransport>[0], api = new ScriptedApi()) => {
    const transport = new ScriptedTransport(handler);
    const logger = new MemoryLogger();
    return { transport, api, logger, client: new GoogleOAuthClient(transport, api, new FixedClock(1_000), new SequenceRandom(), logger, { authorizeUrl: "http://auth", tokenUrl: "http://token" }) };
  };

  test("authorize URL parameters in the source order; loopback metadata", async () => {
    const { client } = make(() => json({}));
    const url = new URL(await client.authorizeUrl({ redirectUri: "http://localhost:5/oauth-callback", state: "st", codeChallenge: "ignored", nonce: "n", fresh: false }));
    expect([...url.searchParams.entries()]).toEqual([
      ["access_type", "offline"],
      ["scope", SCOPES.join(" ")],
      ["state", "st"],
      ["prompt", "consent"],
      ["response_type", "code"],
      ["client_id", CLIENT_ID],
      ["redirect_uri", "http://localhost:5/oauth-callback"],
    ]);
    expect([client.callbackPath, client.manualRedirectUri, client.successRedirect()]).toEqual(["/oauth-callback", undefined, SUCCESS_REDIRECT]);
    expect(PRODUCTION_ENDPOINTS).toEqual({ authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token" });
    const production = new GoogleOAuthClient(new ScriptedTransport(() => json({})), new ScriptedApi(), new FixedClock(), new SequenceRandom(), new MemoryLogger(), PRODUCTION_ENDPOINTS);
    expect((await production.authorizeUrl({ redirectUri: "r", state: "s", codeChallenge: "ignored", nonce: "n", fresh: false })).startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  test("exchange: form body, bootstrap (userinfo → loadCodeAssist), account id = e-mail", async () => {
    const { client, transport, api } = make(() => json({ access_token: "a1", refresh_token: "r1", expires_in: 3599 }));
    const credential = await client.exchange({ code: "c", state: "s", redirectUri: "http://localhost:5/oauth-callback", codeVerifier: "ignored", nonce: "n", callback: {} });
    expect(transport.requests[0]!.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(new URLSearchParams(transport.requests[0]!.body!))).toEqual({ grant_type: "authorization_code", code: "c", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: "http://localhost:5/oauth-callback" });
    expect(api.calls).toEqual(["fetchUserInfo", "loadCodeAssist"]);
    expect(credential.id).toBe("me@x");
    expect(fromCredential(credential)).toEqual({ email: "me@x", tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: 1_000 + 3_599_000 }, projectIds: ["proj-1"], activeProjectId: "proj-1" });
  });

  test("bootstrap degrades: failed userinfo/loadCodeAssist are logged, then onboarding provides the project", async () => {
    const api = new ScriptedApi();
    api.userInfo = () => Promise.reject(new Error("u"));
    api.codeAssist = () => Promise.reject(new Error("l"));
    const { client, logger } = make(() => json({ access_token: "a1", expires_in: "60" }), api);
    const account = fromCredential(await client.exchange({ code: "c", state: "s", redirectUri: "r", codeVerifier: "ignored", nonce: "n", callback: {} }))!;
    expect(account).toEqual({ email: "", tokens: { accessToken: "a1", expiresAt: 61_000 }, projectIds: ["onboarded"], activeProjectId: "onboarded" });
    expect(logger.lines).toEqual(["WARN antigravity: fetchUserInfo failed (Error: u)", "WARN antigravity: loadCodeAssist failed (Error: l)"]);
    const empty = new ScriptedApi();
    empty.userInfo = async () => ({});
    empty.codeAssist = async () => ({});
    empty.onboard = async () => ({});
    const none = fromCredential(await make(() => json({ access_token: "a1" }), empty).client.exchange({ code: "c", state: "s", redirectUri: "r", codeVerifier: "ignored", nonce: "n", callback: {} }))!;
    expect(none).toEqual({ email: "", tokens: { accessToken: "a1", expiresAt: 1_000 + 3_600_000 }, projectIds: [] });
  });

  test("refresh returns the token endpoint's answer (rotated() keeps the old refresh token); needs one", async () => {
    const { client, transport } = make(() => json({ access_token: "a2", expires_in: 10 }));
    expect(await client.refresh(tokens)).toEqual({ accessToken: "a2", expiresAt: 11_000 });
    expect(Object.fromEntries(new URLSearchParams(transport.requests[0]!.body!))).toEqual({ grant_type: "refresh_token", refresh_token: "rt", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(transport.requests[0]!.timeoutMs).toBe(TOKEN_ENDPOINT_TIMEOUT_MS);
    expect(await make(() => json({ access_token: "a2", refresh_token: "rt2", expires_in: 10 })).client.refresh(tokens)).toEqual({ accessToken: "a2", refreshToken: "rt2", expiresAt: 11_000 });
    await expect(client.refresh({ accessToken: "a", expiresAt: 0 })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });

  test.each([
    [{ status: 400, body: '{"error":"invalid_grant"}' }, ProviderAuthRequiredError],
    [{ status: 401, body: "" }, ProviderAuthRequiredError],
    [{ status: 503, body: "down" }, UpstreamError],
    [{ status: 200, body: "not json" }, UpstreamError],
    [{ status: 200, body: '{"access_token":""}' }, UpstreamError],
  ])("token endpoint %p", async (response, kind) => {
    await expect(make(() => response).client.refresh(tokens)).rejects.toBeInstanceOf(kind);
  });
});

class StubOAuth extends AntigravityOAuthPort {
  readonly provider = "antigravity";
  readonly callbackPath = "/oauth-callback";
  readonly manualRedirectUri = undefined;
  calls = 0;
  constructor(private readonly result: (t: AuthTokens) => Promise<AuthTokens> = async () => ({ accessToken: "SECRET-new", expiresAt: 9_000_000_000_000 })) {
    super();
  }
  async authorizeUrl() {
    return "";
  }
  async exchange(): Promise<never> {
    throw new Error("unused");
  }
  successRedirect() {
    return "";
  }
  refresh(t: AuthTokens) {
    this.calls++;
    return this.result(t);
  }
}

describe("AntigravitySession", () => {
  const setup = (stored?: AntigravityAccount, oauth = new StubOAuth()) => {
    const store = new MemoryCredentialStore();
    if (stored) store.pools.set("antigravity", upsertAccount(EMPTY_POOL, { ...toCredential(stored, "me@x"), label: "Me" }));
    const lock = new RecordingLock();
    const logger = new MemoryLogger();
    return { store, lock, oauth, logger, session: new AntigravitySession(store, oauth, lock, new FixedClock(1_000_000), logger) };
  };

  test("fresh token: no lock, no refresh", async () => {
    const { session, lock, oauth } = setup(acct());
    expect((await session.active()).account.tokens.accessToken).toBe("at");
    expect([lock.acquired, oauth.calls]).toEqual([[], 0]);
  });

  test("G5: an expiring token is refreshed before use, persisted with the label, logged without secrets", async () => {
    const { session, store, lock, logger } = setup(acct({ tokens: { accessToken: "old", refreshToken: "SECRET-rt", expiresAt: 1_060_000 } }));
    const active = await session.active();
    expect(active.account.tokens).toEqual({ accessToken: "SECRET-new", refreshToken: "SECRET-rt", expiresAt: 9_000_000_000_000 });
    expect(lock.acquired).toEqual([REFRESH_LOCK]);
    const saved = activeAccount(await store.load("antigravity"))!;
    expect(saved.label).toBe("Me");
    expect(fromCredential(saved)!.tokens.accessToken).toBe("SECRET-new");
    expect(logger.lines.join("\n")).not.toContain("SECRET");
  });

  test("single flight and another process's rotation reused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new StubOAuth(async () => {
      await gate;
      return { accessToken: "SECRET-new", expiresAt: 9_000_000_000_000 };
    });
    const { session } = setup(acct({ tokens: { accessToken: "old", refreshToken: "r", expiresAt: 0 } }), slow);
    const all = Promise.all([session.active(), session.active()]);
    await Bun.sleep(5);
    release();
    expect((await all).map((a) => a.account.tokens.accessToken)).toEqual(["SECRET-new", "SECRET-new"]);
    expect(slow.calls).toBe(1);
    const other = setup(acct({ tokens: { accessToken: "old", refreshToken: "r", expiresAt: 0 } }));
    other.lock.onAcquire = async () => other.store.seed("antigravity", upsertAccount(EMPTY_POOL, toCredential(acct({ tokens: { accessToken: "by-other", expiresAt: 9_000_000_000_000 } }), "me@x")));
    expect((await other.session.active()).account.tokens.accessToken).toBe("by-other");
    expect(other.oauth.calls).toBe(0);
  });

  test("forceRenew rotates regardless of expiry, or reuses a token already rotated by someone else", async () => {
    const { session, oauth } = setup(acct());
    const current = await session.active();
    expect((await session.forceRenew(current)).account.tokens.accessToken).toBe("SECRET-new");
    expect(oauth.calls).toBe(1);
    expect((await session.forceRenew(current)).account.tokens.accessToken).toBe("SECRET-new");
    expect(oauth.calls).toBe(1);
  });

  test("missing or unreadable account", async () => {
    await expect(setup().session.active()).rejects.toThrow("no active account");
    const { session, store } = setup();
    store.pools.set("antigravity", upsertAccount(EMPTY_POOL, { provider: "antigravity", id: "bad", label: "bad", data: {} }));
    await expect(session.active()).rejects.toThrow("stored credential of bad is unreadable");
  });
});

describe("AntigravityState", () => {
  test("session id minted once (FNV int64), persisted, reused; an invalid stored value is replaced", async () => {
    const kv = new MemoryKeyValueStore();
    const state = new AntigravityState(kv, new SequenceRandom());
    const id = await state.sessionId();
    expect(id).toMatch(/^-?\d+$/);
    expect(kv.values.get(SESSION_ID_KEY)).toBe(id);
    expect(await state.sessionId()).toBe(id);
    expect(await new AntigravityState(kv, new SequenceRandom()).sessionId()).toBe(id);
    kv.values.set(SESSION_ID_KEY, 12345);
    expect(await new AntigravityState(kv, new SequenceRandom()).sessionId()).toBe(id);
  });

  test("signatures: tolerant load, write-through, re-capture refreshes age, oldest evicted past the cap", async () => {
    const kv = new MemoryKeyValueStore();
    kv.values.set(SIGNATURES_KEY, { a: "1", bad: 2 });
    const state = new AntigravityState(kv, new SequenceRandom(), 2);
    expect(await state.signatures()).toEqual({ a: "1" });
    await state.saveSignature("b", "2");
    await state.saveSignature("a", "1b");
    await state.saveSignature("c", "3");
    expect(kv.values.get(SIGNATURES_KEY)).toEqual({ a: "1b", c: "3" });
    const arrayStored = new MemoryKeyValueStore();
    arrayStored.values.set(SIGNATURES_KEY, ["x"]);
    expect(await new AntigravityState(arrayStored, new SequenceRandom()).signatures()).toEqual({});
    expect(await new AntigravityState(new MemoryKeyValueStore(), new SequenceRandom()).signatures()).toEqual({});
  });

  test("concurrent saves: one read, writes never overlap, a burst coalesces, the last write holds the newest map; a failed write rejects only its callers", async () => {
    class SlowStore extends MemoryKeyValueStore {
      reads = 0;
      writes: unknown[] = [];
      active = 0;
      overlapped = false;
      fail = false;
      override async read(key: string) {
        this.reads++;
        await Bun.sleep(5);
        return super.read(key);
      }
      override async write(key: string, value: JsonValue) {
        this.overlapped ||= this.active > 0;
        this.active++;
        await Bun.sleep(5);
        this.active--;
        if (this.fail) throw new Error("disk full");
        this.writes.push(value);
        return super.write(key, value);
      }
    }
    const kv = new SlowStore();
    const state = new AntigravityState(kv, new SequenceRandom());
    await Promise.all(Array.from({ length: 50 }, (_, i) => state.saveSignature(`c${i}`, `S${i}`)));
    expect([kv.reads, kv.overlapped, kv.writes.length <= 3]).toEqual([1, false, true]);
    expect(Object.keys(kv.values.get(SIGNATURES_KEY) as object)).toHaveLength(50);
    kv.fail = true;
    await expect(state.saveSignature("x", "X")).rejects.toThrow("disk full");
    kv.fail = false;
    await state.saveSignature("y", "Y");
    expect(Object.keys(kv.values.get(SIGNATURES_KEY) as object)).toHaveLength(52);
  });
});

class FixedSession extends OAuthSessionPort<AntigravityAccount> {
  rotations = 0;
  constructor(private current: ActiveAccount = { id: "me@x", account: acct() }) {
    super();
  }
  async active() {
    return this.current;
  }
  async forceRenew(_c: ActiveAccount) {
    this.rotations++;
    this.current = { ...this.current, account: { ...this.current.account, tokens: { ...tokens, accessToken: `rotated-${this.rotations}` } } };
    return this.current;
  }
}

describe("withActive", () => {
  test("401 → one forced rotation and a retry; other errors and missing refresh tokens propagate", async () => {
    const session = new FixedSession();
    let n = 0;
    expect(await withActive(session, async (a) => (n++ === 0 ? Promise.reject(new UpstreamError("antigravity", 401, "")) : a.account.tokens.accessToken))).toBe("rotated-1");
    await expect(withActive(session, () => Promise.reject(new UpstreamError("antigravity", 500, "")))).rejects.toBeInstanceOf(UpstreamError);
    const noRefresh = new FixedSession({ id: "x", account: acct({ tokens: { accessToken: "a", expiresAt: 9e12 } }) });
    await expect(withActive(noRefresh, () => Promise.reject(new UpstreamError("antigravity", 401, "")))).rejects.toBeInstanceOf(UpstreamError);
    expect(noRefresh.rotations).toBe(0);
  });
});

describe("AntigravityCatalog and AntigravityQuota", () => {
  test("descriptors fetched live and memoized; a miss refetches once; unknown stays undefined", async () => {
    const api = new ScriptedApi();
    const logger = new MemoryLogger();
    const catalog = new AntigravityCatalog(api, new FixedSession(), logger);
    expect((await catalog.descriptor("gemini-3.6-flash-low"))?.enumPlaceholder).toBe("MODEL_PLACEHOLDER_M73");
    expect(await catalog.descriptor("gemini-3.6-flash-low")).toBeDefined();
    expect(api.calls).toEqual(["fetchAvailableModels"]);
    expect(await catalog.descriptor("nope")).toBeUndefined();
    expect(api.calls).toEqual(["fetchAvailableModels", "fetchAvailableModels"]);
    expect(logger.lines[0]).toBe("INFO antigravity: resolved 4 models for me@x");
  });

  test("quota usage view", async () => {
    const view = await new AntigravityQuota(new ScriptedApi(), new FixedSession(), new FixedClock(5)).usage();
    expect(view.capturedAt).toBe(5);
    expect(view.text.startsWith("Antigravity usage:")).toBe(true);
  });
});

class InstantTimer extends TimerPort {
  readonly waits: number[] = [];
  async sleep(ms: number) {
    this.waits.push(ms);
  }
}

class MemoryState extends AntigravityStatePort {
  saved: Record<string, string> = {};
  fail = false;
  async sessionId() {
    return "-42";
  }
  async signatures() {
    return { known: "SIG-K" };
  }
  async saveSignature(id: string, sig: string) {
    if (this.fail) throw new Error("disk full");
    this.saved[id] = sig;
  }
}

describe("AntigravityRunner", () => {
  const turns = [{ role: "user" as const, text: "hi" }];
  const capture = (): StreamEnvelope[] =>
    text("stream-generate.sample.sse")
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as StreamEnvelope);
  const make = (stream: ScriptedApi["stream"], session = new FixedSession(), state = new MemoryState()) => {
    const api = new ScriptedApi();
    api.stream = stream;
    const timer = new InstantTimer();
    const logger = new MemoryLogger();
    const runner = new AntigravityRunner(api, session, state, new SequenceRandom(), new FixedClock(77), timer, logger);
    const run = (input: { turns?: typeof turns } = {}) =>
      runner.run({
        modelWireId: "gemini-3.6-flash-low",
        modelEnum: "MODEL_PLACEHOLDER_M73",
        turns: input.turns ?? turns,
        build: (snapshot) => ({ labels: snapshot.labels, sessionId: snapshot.sessionId }),
        map: (envelope) => envelope,
      });
    return { api, timer, logger, session, state, run };
  };
  async function* from(envelopes: StreamEnvelope[]) {
    for (const e of envelopes) yield e;
  }

  test("every envelope is mapped; trajectory envelope; step counter advances after completion", async () => {
    const { run, api } = make(() => from(capture()));
    expect(await drain(run())).toEqual(capture());
    await drain(run({ turns: [...turns, { role: "assistant", text: "Hello, world!" }, { role: "user", text: "again" }] as typeof turns }));
    expect(api.streams.map((p) => [p.project, p.modelWireId, p.requestId])).toEqual([
      ["proj-1", "gemini-3.6-flash-low", "agent/uuid-1/77/uuid-2/3"],
      ["proj-1", "gemini-3.6-flash-low", "agent/uuid-1/77/uuid-2/6"],
    ]);
    const body = api.streams[0]!.body as { labels: Record<string, string>; sessionId: string };
    expect(body.sessionId).toBe("-42");
    expect(body.labels.model_enum).toBe("MODEL_PLACEHOLDER_M73");
  });

  test("an account without a project is an auth error", async () => {
    const { run } = make(() => from([]), new FixedSession({ id: "x", account: acct({ projectIds: [], activeProjectId: undefined } as never) }));
    await expect(drain(run())).rejects.toThrow("account x has no project assigned");
  });

  test("401 → one forced rotation then success; a second 401 propagates", async () => {
    const once = make((_p, _t, call) => (call === 1 ? (async function* () { throw new UpstreamError("antigravity", 401, ""); })() : from(capture())));
    expect((await drain(once.run())).length).toBe(capture().length);
    expect(once.session.rotations).toBe(1);
    expect(once.api.streams[0]!.requestId).toBe(once.api.streams[1]!.requestId);
    const twice = make(() => (async function* () { throw new UpstreamError("antigravity", 401, ""); })());
    await expect(drain(twice.run())).rejects.toBeInstanceOf(UpstreamError);
    expect(twice.session.rotations).toBe(1);
  });

  test("geo gate retried twice with 2 s / 8 s backoff, then propagated; never retried after an envelope", async () => {
    const gate = () => (async function* () { throw new UpstreamError("antigravity", 400, "User location is not supported for the API use"); })();
    const { run, timer, logger } = make(gate);
    await expect(drain(run())).rejects.toBeInstanceOf(UpstreamError);
    expect(timer.waits).toEqual([2000, 8000]);
    expect(logger.lines.filter((l) => l.includes("geo gate"))).toHaveLength(2);
    const first = { response: { candidates: [{ content: { parts: [{ text: "x" }] } }] } } as StreamEnvelope;
    const late = make(() => (async function* () {
      yield first;
      throw new UpstreamError("antigravity", 400, "User location is not supported");
    })());
    const seen: StreamEnvelope[] = [];
    await expect((async () => { for await (const c of late.run()) seen.push(c); })()).rejects.toBeInstanceOf(UpstreamError);
    expect(seen).toEqual([first]);
    expect(late.timer.waits).toEqual([]);
  });
});

class SampleCatalog extends AntigravityCatalogPort {
  async descriptors() {
    return toModelDescriptors(JSON.parse(text("fetch-available-models.sample.json")) as Record<string, unknown>);
  }
  async descriptor(wireId: string) {
    return (await this.descriptors()).find((d) => d.wireId === wireId);
  }
}

describe("AntigravityNative", () => {
  test("unwraps envelopes, caches and persists signed calls, forwards the signal; persist failures are only warned", async () => {
    const api = new ScriptedApi();
    const signed: StreamEnvelope = { response: { candidates: [{ content: { parts: [{ functionCall: { id: "c9", name: "ls" }, thoughtSignature: "SIG-9" }] } }] } };
    api.stream = async function* () {
      yield signed;
      yield { candidates: [] } as unknown as StreamEnvelope;
    };
    const state = new MemoryState();
    state.fail = true;
    const logger = new MemoryLogger();
    const native = new AntigravityNative(new AntigravityRunner(api, new FixedSession(), state, new SequenceRandom(), new FixedClock(77), new InstantTimer(), logger), state, logger);
    expect(await native.signatures()).toEqual({ known: "SIG-K" });
    const model = (await new SampleCatalog().descriptor("gemini-3.6-flash-low"))!;
    const prepared = prepareGeminiRequest({ contents: [{ parts: [{ text: "hi" }] }] }, model, { lossy: false, signatures: {} });
    const controller = new AbortController();
    const out = await drain(native.generate({ model, prepared, signal: controller.signal }));
    expect(out).toEqual([signed.response as unknown as Record<string, unknown>, { candidates: [] }]);
    expect(await native.signatures()).toEqual({ known: "SIG-K", c9: "SIG-9" });
    expect(api.signals).toEqual([controller.signal]);
    const body = api.streams[0]!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["contents", "labels", "generationConfig", "sessionId"]);
    expect(body["sessionId"]).toBe("-42");
    await drain(native.generate({ model, prepared, signal: undefined }));
    expect(api.signals[1]).toBeUndefined();
    await Bun.sleep(1);
    expect(logger.lines.some((l) => l.includes("signature persist failed (Error: disk full)"))).toBe(true);
    expect(unwrapEnvelope({ response: { responseId: "r" } })).toEqual({ responseId: "r" });
  });
});

describe("AntigravityProvider", () => {
  const capture = (): StreamEnvelope[] =>
    text("stream-generate.sample.sse")
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as StreamEnvelope);
  const make = (stream: ScriptedApi["stream"] = async function* () { yield* capture(); }) => {
    const api = new ScriptedApi();
    api.stream = stream;
    const state = new MemoryState();
    const logger = new MemoryLogger();
    const runner = new AntigravityRunner(api, new FixedSession(), state, new SequenceRandom(), new FixedClock(77), new InstantTimer(), logger);
    const provider = new AntigravityProvider(new SampleCatalog(), new AntigravityNative(runner, state, logger), logger);
    return { api, state, logger, provider };
  };
  const raw = (method: string, body: unknown, query: Record<string, string> = {}, lossy = false): RawRequest => ({
    format: "gemini",
    path: `/v1beta/models/antigravity/gemini-3.6-flash-low:${method}`,
    query,
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
    lossy,
  });
  const hello = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const decode = async (body: AsyncIterable<Uint8Array>) => (await drain(body)).map((c) => new TextDecoder().decode(c));

  test("identity, models (live, advertised limits, 80k clamp; limits omitted when output is unknown)", async () => {
    const { provider } = make();
    expect([provider.id, [...(await provider.nativeFormats("any"))]]).toEqual(["antigravity", ["gemini"]]);
    const catalog = await provider.models();
    expect([catalog.provider, catalog.source]).toEqual(["antigravity", "live"]);
    expect(catalog.models.find((m) => m.address.model === "gemini-3.6-flash-low")).toEqual({ address: { provider: "antigravity", model: "gemini-3.6-flash-low" }, displayName: "Gemini 3.6 Flash (Low)", contextWindow: 80_000, maxOutputTokens: 65_536, details: { input: ["text", "image", "video"], reasoning: true } });
    expect(catalog.models.find((m) => m.address.model === "chat_20706")).toEqual({ address: { provider: "antigravity", model: "chat_20706" }, displayName: "Chat (no output limit)", details: { input: ["text"], reasoning: false } });
  });

  test("route, method, model and body checks happen before any upstream call", async () => {
    const { provider, api } = make();
    await expect(provider.passthrough("gemini-3.6-flash-low", { ...raw("x", hello), path: "/v1beta/models/m:embedContent" })).rejects.toBeInstanceOf(InvalidRequestError);
    const count = await provider.passthrough("gemini-3.6-flash-low", raw("countTokens", hello)).catch((e: unknown) => e);
    expect((count as UnsupportedFeatureError).features).toEqual(["countTokens"]);
    await expect(provider.passthrough("nope", raw("generateContent", hello))).rejects.toBeInstanceOf(UnknownModelError);
    await expect(provider.passthrough("gemini-3.6-flash-low", raw("generateContent", "{bad"))).rejects.toThrow("not valid JSON");
    await expect(provider.passthrough("gemini-3.6-flash-low", raw("generateContent", { ...hello, safetySettings: [] }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(api.streams).toHaveLength(0);
  });

  test("streamGenerateContent?alt=sse: one data frame per upstream response, CRLF-delimited, streamed", async () => {
    const { provider, api, logger } = make();
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello, { alt: "sse" }));
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/event-stream" });
    const frames = await decode(response.body);
    expect(frames).toEqual(capture().map((e) => `data: ${JSON.stringify(e.response)}\r\n\r\n`));
    const body = api.streams[0]!.body as Record<string, unknown>;
    expect(body["generationConfig"]).toEqual({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } });
    expect(logger.lines.some((l) => l.includes("streamGenerateContent model=gemini-3.6-flash-low (sse)"))).toBe(true);
  });

  test("streamGenerateContent without alt: a JSON array written incrementally", async () => {
    const { provider } = make();
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello));
    expect(response.headers["content-type"]).toBe("application/json");
    const chunks = await decode(response.body);
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.startsWith("[{")).toBe(true);
    expect(chunks[1]!.startsWith(",\r\n{")).toBe(true);
    expect(chunks[3]).toBe("]");
    expect(JSON.parse(chunks.join(""))).toEqual(capture().map((e) => e.response));
  });

  test("generateContent: the stream merged into one response (decision Q4)", async () => {
    const { provider, logger } = make();
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("generateContent", hello));
    expect(response.headers).toEqual({ "content-type": "application/json" });
    const merged = JSON.parse((await decode(response.body)).join("")) as { candidates: { content: { parts: unknown[] }; finishReason: string }[]; responseId: string };
    expect(merged.candidates[0]!.content.parts).toEqual([{ text: "Hello, world!", thoughtSignature: "c2FtcGxlLXNpZ25hdHVyZQ==" }]);
    expect(merged.candidates[0]!.finishReason).toBe("STOP");
    expect(merged.responseId).toBe("resp-1");
    expect(logger.lines.some((l) => l.includes("3 upstream responses merged"))).toBe(true);
  });

  test("an empty upstream stream is a 502 upstream error, never an empty 200", async () => {
    for (const method of ["generateContent", "streamGenerateContent"]) {
      const { provider } = make(async function* () {});
      const error = await provider.passthrough("gemini-3.6-flash-low", raw(method, hello)).catch((e: unknown) => e);
      expect((error as UpstreamError).httpStatus).toBe(502);
    }
  });

  test("an error before the first response is thrown (rendered by the HTTP adapter)", async () => {
    const { provider } = make(async function* () {
      throw new UpstreamError("antigravity", 400, '{"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT"}}');
    });
    await expect(provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello, { alt: "sse" }))).rejects.toBeInstanceOf(UpstreamError);
  });

  test("an error after the first byte closes the stream with a Google error element (SSE and JSON array)", async () => {
    const failing = (error: unknown) =>
      async function* () {
        yield capture()[0]!;
        throw error;
      };
    const sse = make(failing(new UpstreamError("antigravity", 503, '{"error":{"code":503,"message":"no capacity","status":"UNAVAILABLE"}}')));
    const frames = await decode((await sse.provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello, { alt: "sse" }))).body);
    expect(frames.at(-1)).toBe('data: {"error":{"code":503,"message":"no capacity","status":"UNAVAILABLE"}}\r\n\r\n');
    expect(sse.logger.lines.some((l) => l.startsWith("WARN antigravity: stream failed after the first byte"))).toBe(true);

    const json = make(failing(new TypeError("connection reset")));
    const body = (await decode((await json.provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello))).body)).join("");
    expect(JSON.parse(body)[1]).toEqual({ error: { code: 500, message: "internal proxy error (details are in the proxy log)", status: "INTERNAL" } });
    expect(json.logger.lines.some((l) => l.endsWith("connection reset"))).toBe(true);
  });

  test("a client that stops reading ends the upstream stream", async () => {
    let finished = false;
    const { provider } = make(async function* () {
      try {
        yield* capture();
      } finally {
        finished = true;
      }
    });
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello, { alt: "sse" }));
    const iterator = response.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(finished).toBe(true);
  });

  test("lossy drops are reported in x-proxy-dropped; the client signal reaches the upstream call", async () => {
    const { provider, api } = make();
    const controller = new AbortController();
    const response = await provider.passthrough("gemini-3.6-flash-low", { ...raw("generateContent", { ...hello, safetySettings: [] }, {}, true), signal: controller.signal });
    expect(response.headers["x-proxy-dropped"]).toBe("safetySettings");
    expect(api.signals[0]).toBe(controller.signal);
  });

  test("law 6 end to end: a signature seen in a response signs the replayed call of the next request", async () => {
    const call: StreamEnvelope = { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_1", name: "get_time", args: {} }, thoughtSignature: "SIG-LIVE" }] }, finishReason: "STOP" }] } };
    const { provider, api } = make(async function* () {
      yield call;
    });
    await decode((await provider.passthrough("gemini-3.6-flash-low", raw("generateContent", hello))).body);
    const replay = {
      contents: [
        ...hello.contents,
        { role: "model", parts: [{ functionCall: { id: "call_1", name: "get_time", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "call_1", name: "get_time", response: { output: "13:00" } } }] },
      ],
    };
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("generateContent", replay));
    expect(response.headers["x-proxy-dropped"]).toBeUndefined();
    const contents = (api.streams[1]!.body as { contents: { role: string; parts: Record<string, unknown>[] }[] }).contents;
    expect(contents[1]!.parts[0]!["thoughtSignature"]).toBe("SIG-LIVE");
    expect(contents[2]!.role).toBe("model");
  });
});
