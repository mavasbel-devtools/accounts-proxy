// provider-openai adapters over the shared test doubles; ID tokens are signed with a real RSA key (IdTokenSigner).
import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, TOKEN_ENDPOINT_TIMEOUT_MS, upsertAccount } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UnsupportedFeatureError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import { DROPPED_HEADER, readAll, type HttpRequest, type RawRequest } from "@inference-router/core/domain/wire.ts";
import { FixedClock, MemoryCredentialStore, MemoryKeyValueStore, MemoryLogger, RecordingLock, ScriptedTransport, SequenceRandom, type ScriptedResponse } from "@inference-router/test-support/fakes.ts";
import { IdTokenSigner } from "@inference-router/test-support/openai-id-token.ts";
import { JwksIdTokenVerifier } from "@inference-router/provider-openai/adapters/outbound/jwks-id-token-verifier.ts";
import { CATALOG_KEY, OpenAICatalog } from "@inference-router/provider-openai/adapters/outbound/openai-catalog.ts";
import { HOST_ID_KEY, OpenAIIdentity } from "@inference-router/provider-openai/adapters/outbound/openai-identity.ts";
import { OpenAIOAuthClient } from "@inference-router/provider-openai/adapters/outbound/openai-oauth-client.ts";
import { forwardedResponseHeaders, NATIVE_PATH, OpenAIProvider, sseEvents } from "@inference-router/provider-openai/adapters/outbound/openai-provider.ts";
import { OpenAISession, REFRESH_LOCK } from "@inference-router/provider-openai/adapters/outbound/openai-session.ts";
import { STATIC_CATALOG } from "@inference-router/provider-openai/domain/catalog.ts";
import { SCOPES } from "@inference-router/provider-openai/domain/constants.ts";
import { fromAccount, toAccount, type OpenAITokens } from "@inference-router/provider-openai/domain/credential.ts";
import type { ExpectedClaims, VerifiedIdentity } from "@inference-router/provider-openai/domain/id-token.ts";
import { IdTokenVerifierPort, OpenAICatalogPort, OpenAIIdentityPort, type CatalogListing } from "@inference-router/provider-openai/ports/outbound/openai.ts";
import type { Session } from "@inference-router/core/ports/outbound/session.ts";
import { OAuthSessionPort } from "@inference-router/core/ports/outbound/session.ts";

const NOW = 1_800_000_000_000;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): ScriptedResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const tokens: OpenAITokens = { accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3_600_000, scopes: SCOPES, clientId: "oaiapp_saved", subject: "user-e2e-subject", idToken: "i.d.t", email: "e2e@example.com" };

class FixedIdentity extends OpenAIIdentityPort {
  readonly sessionId = "proc-session";
  async hostId() {
    return "urn:uuid:00000000-0000-4000-8000-000000000000";
  }
}

class StubVerifier extends IdTokenVerifierPort {
  seen: ExpectedClaims[] = [];
  constructor(private readonly identity: VerifiedIdentity = { subject: "user-e2e-subject", email: "e2e@example.com" }) {
    super();
  }
  async verify(_token: string, expected: ExpectedClaims) {
    this.seen.push(expected);
    return this.identity;
  }
}

describe("OpenAIIdentity (S4)", () => {
  test("creates a urn:uuid host id once and keeps any accepted stored form; one session id per process", async () => {
    const store = new MemoryKeyValueStore();
    const identity = new OpenAIIdentity(store, new SequenceRandom());
    expect(identity.sessionId).toBe("uuid-1");
    store.values.set(HOST_ID_KEY, "garbage");
    const created = await identity.hostId();
    expect(created).toMatch(/^urn:uuid:/);
    expect(await identity.hostId()).toBe(created);
    expect(store.values.get(HOST_ID_KEY)).toBe(created);
    for (const kept of ["urn:uuid:123e4567-e89b-42d3-a456-426614174000", "urn:ietf:params:oauth:jwk-thumbprint:sha-256:abc", "did:key:z6Mk"]) {
      const other = new MemoryKeyValueStore();
      other.values.set(HOST_ID_KEY, kept);
      expect(await new OpenAIIdentity(other, new SequenceRandom()).hostId()).toBe(kept);
    }
  });
});

describe("JwksIdTokenVerifier (S12)", () => {
  const signer = new IdTokenSigner("k1");
  const expected = { clientId: "oaiapp_1", nonce: "n", now: 0 };
  const make = (...answers: ScriptedResponse[]) => {
    const transport = new ScriptedTransport((_r, i) => answers[Math.min(i, answers.length - 1)]!);
    return { transport, verifier: new JwksIdTokenVerifier(transport, new FixedClock(NOW), "http://auth/.well-known/jwks.json") };
  };

  test("a valid token verifies; the key set is fetched for each verification and once more when the kid is unknown", async () => {
    const keys = json(signer.jwks([{ kty: "EC", kid: "ec" }, { kty: "RSA", kid: "enc", use: "enc" }]));
    const { transport, verifier } = make(keys, keys);
    const token = signer.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW));
    expect(await verifier.verify(token, expected)).toEqual({ subject: "user-e2e-subject", email: "e2e@example.com" });
    expect(await verifier.verify(token, expected)).toEqual({ subject: "user-e2e-subject", email: "e2e@example.com" });
    expect(transport.requests.map((r) => [r.method, r.url, r.headers["user-agent"]])).toEqual([
      ["GET", "http://auth/.well-known/jwks.json", "inference-router/0.1.0"],
      ["GET", "http://auth/.well-known/jwks.json", "inference-router/0.1.0"],
    ]);
    const rotated = new IdTokenSigner("k2");
    const second = make(json(signer.jwks()), json(rotated.jwks()));
    expect((await second.verifier.verify(rotated.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW)), expected)).subject).toBe("user-e2e-subject");
    expect(second.transport.requests).toHaveLength(2);
  });

  test("a token without kid uses the only RSA key; several keys and no kid is no key", async () => {
    const token = signer.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW), { kid: undefined });
    expect((await make(json(signer.jwks())).verifier.verify(token, expected)).subject).toBe("user-e2e-subject");
    const two = { keys: [...signer.jwks().keys, ...new IdTokenSigner("k9").jwks().keys] };
    await expect(make(json(two)).verifier.verify(token, expected)).rejects.toThrow("ChatGPT sign-in returned an invalid ID token: no RSA key (no kid) in the published key set");
  });

  test("a wrong signature, a foreign key, bad claims and a malformed token ask for a new login", async () => {
    const other = new IdTokenSigner("k1");
    const forged = other.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW));
    await expect(make(json(signer.jwks())).verifier.verify(forged, expected)).rejects.toThrow("ChatGPT sign-in returned an invalid ID token: the signature does not verify");
    await expect(make(json(signer.jwks())).verifier.verify(signer.sign(IdTokenSigner.claims("oaiapp_1", "other", NOW)), expected)).rejects.toThrow(
      new ProviderAuthRequiredError("openai", "ChatGPT sign-in returned an invalid ID token: the nonce does not match this sign-in attempt"),
    );
    await expect(make(json(signer.jwks())).verifier.verify(signer.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW - 7_200_000)), expected)).rejects.toThrow("expired or without exp");
    await expect(make(json(signer.jwks())).verifier.verify(signer.sign({}, { kid: "zz" }), expected)).rejects.toThrow("no RSA key zz in the published key set");
    await expect(make(json(signer.jwks())).verifier.verify("x", expected)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });

  test("a failing or malformed key set is an upstream error", async () => {
    const token = signer.sign(IdTokenSigner.claims("oaiapp_1", "n", NOW));
    await expect(make({ status: 503, body: "down" }).verifier.verify(token, expected)).rejects.toThrow(new UpstreamError("openai", 503, "JWKS: down"));
    await expect(make({ status: 200, body: "{oops" }).verifier.verify(token, expected)).rejects.toThrow(new UpstreamError("openai", 502, "JWKS is not a key set: {oops"));
    await expect(make(json({ keys: {} })).verifier.verify(token, expected)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("OpenAIOAuthClient (S1–S16, T2–T4)", () => {
  const granted = (over: Record<string, unknown> = {}) => json({ access_token: "a1", refresh_token: "r1", id_token: "i.d.t", expires_in: 3600, scope: SCOPES, ...over });
  const make = (answer: (request: HttpRequest) => ScriptedResponse = () => granted(), verifier = new StubVerifier()) => {
    const transport = new ScriptedTransport(answer);
    const store = new MemoryCredentialStore();
    const client = new OpenAIOAuthClient(transport, store, new FixedIdentity(), verifier, new FixedClock(NOW), "http://auth");
    return { transport, store, client, verifier };
  };
  const authorize = (client: OpenAIOAuthClient, fresh = false, state = "st") => client.authorizeUrl({ redirectUri: client.redirectUri(1455), state, nonce: "no", codeChallenge: "ch", fresh });
  const exchange = (client: OpenAIOAuthClient, callback: Record<string, string>, state = "st") => client.exchange({ code: "c0de", state, redirectUri: "http://127.0.0.1:1455/auth/callback", codeVerifier: "ver", nonce: "no", callback });

  test("first registration: dynamic_agent_client, agent name, host id, 127.0.0.1 callback, chatgpt.ts parameter order", async () => {
    const { client } = make();
    expect([client.provider, client.callbackPath, client.manualRedirectUri, client.successRedirect()]).toEqual(["openai", "/auth/callback", undefined, undefined]);
    const url = new URL(await authorize(client));
    expect(`${url.origin}${url.pathname}`).toBe("http://auth/api/accounts/authorize");
    expect([...url.searchParams.entries()]).toEqual([
      ["client_id", "dynamic_agent_client"],
      ["agent_name_hint", "inference-router"],
      ["ext_agent_host_id", "urn:uuid:00000000-0000-4000-8000-000000000000"],
      ["response_type", "code"],
      ["redirect_uri", "http://127.0.0.1:1455/auth/callback"],
      ["scope", "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"],
      ["resource", "https://api.openai.com/v1"],
      ["state", "st"],
      ["nonce", "no"],
      ["code_challenge_method", "S256"],
      ["code_challenge", "ch"],
    ]);
  });

  test("exchange of a new registration: the callback's issued client id, form body in chatgpt.ts order, verified identity", async () => {
    const { client, transport, verifier } = make();
    await authorize(client);
    const account = await exchange(client, { code: "c0de", state: "st", client_id: "oaiapp_new" });
    const sent = transport.requests[0]!;
    expect([sent.method, sent.url, sent.timeoutMs]).toEqual(["POST", "http://auth/api/accounts/oauth/token", TOKEN_ENDPOINT_TIMEOUT_MS]);
    expect(sent.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "inference-router/0.1.0" });
    expect([...new URLSearchParams(sent.body!).entries()]).toEqual([
      ["grant_type", "authorization_code"],
      ["client_id", "oaiapp_new"],
      ["code", "c0de"],
      ["code_verifier", "ver"],
      ["redirect_uri", "http://127.0.0.1:1455/auth/callback"],
      ["resource", "https://api.openai.com/v1"],
    ]);
    expect(verifier.seen).toEqual([{ clientId: "oaiapp_new", nonce: "no", now: NOW }]);
    expect(account).toEqual(toAccount({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 3_600_000, scopes: SCOPES, clientId: "oaiapp_new", subject: "user-e2e-subject", idToken: "i.d.t", email: "e2e@example.com" }));
    const anonymous = make(() => granted(), new StubVerifier({ subject: "s2" }));
    await authorize(anonymous.client);
    expect((await exchange(anonymous.client, { client_id: "oaiapp_2" })).label).toBe("s2");
  });

  test("re-authorization of the active registration: its client id, no agent name; the callback may omit the client id", async () => {
    const { client, store } = make();
    store.seed("openai", upsertAccount(EMPTY_POOL, toAccount(tokens)));
    const url = new URL(await authorize(client));
    expect(url.searchParams.get("client_id")).toBe("oaiapp_saved");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect((await exchange(client, {})).id).toBe("oaiapp_saved");
    await authorize(client);
    expect((await exchange(client, { client_id: "oaiapp_saved" })).id).toBe("oaiapp_saved");
    expect(new URL(await authorize(client, true)).searchParams.get("client_id")).toBe("dynamic_agent_client");
  });

  test.each([
    ["an unknown attempt with a saved registration (never re-authorized)", true, {}, "ChatGPT sign-in did not return an issued client id (registration incomplete); sign in again", "other"],
    ["a different client on re-authorization", true, { client_id: "oaiapp_other" }, "ChatGPT returned a different client than this registration; sign in again", "st"],
    ["a registration without an issued client id", false, {}, "ChatGPT sign-in did not return an issued client id (registration incomplete); sign in again", "st"],
    ["the registration entry point as client id", false, { client_id: "dynamic_agent_client" }, "registration incomplete", "st"],
    ["an empty client id", false, { client_id: "" }, "registration incomplete", "st"],
  ])("rejected callback: %s", async (_name, saved, callback, message, state) => {
    const { client, store } = make();
    if (saved) store.seed("openai", upsertAccount(EMPTY_POOL, toAccount(tokens)));
    await authorize(client);
    const error = await exchange(client, callback, state).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAuthRequiredError);
    expect((error as Error).message).toContain(message);
  });

  test("the grant must enable plan usage and carry an ID token; a re-authorization must return the same account", async () => {
    const noScope = make(() => granted({ scope: "openid profile email" }));
    await authorize(noScope.client);
    await expect(exchange(noScope.client, { client_id: "c" })).rejects.toThrow("the sign-in did not grant ChatGPT plan usage (chatgpt.tokens.use.direct)");
    const noScopeAtAll = make(() => granted({ scope: undefined }));
    await authorize(noScopeAtAll.client);
    await expect(exchange(noScopeAtAll.client, { client_id: "c" })).rejects.toThrow("did not grant ChatGPT plan usage");
    const noIdToken = make(() => granted({ id_token: undefined }));
    await authorize(noIdToken.client);
    await expect(exchange(noIdToken.client, { client_id: "c" })).rejects.toThrow("ChatGPT sign-in did not return an ID token");
    const other = make(() => granted(), new StubVerifier({ subject: "someone-else" }));
    other.store.seed("openai", upsertAccount(EMPTY_POOL, toAccount(tokens)));
    await authorize(other.client);
    await expect(exchange(other.client, {})).rejects.toThrow("the sign-in returned a different ChatGPT account than this registration; use `login openai --new` to add it");
  });

  test("refresh: form body in chatgpt.ts order; the rotated refresh token replaces the old one", async () => {
    const { client, transport } = make(() => json({ access_token: "a2", refresh_token: "r2", expires_in: 60, scope: SCOPES }));
    expect(await client.refresh(tokens)).toEqual({ ...tokens, accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 60_000 });
    expect([...new URLSearchParams(transport.requests[0]!.body!).entries()]).toEqual([
      ["grant_type", "refresh_token"],
      ["client_id", "oaiapp_saved"],
      ["refresh_token", "rt"],
      ["resource", "https://api.openai.com/v1"],
    ]);
  });

  test("token endpoint answers: 400/401 reject the grant (with the OAuth error code), other failures are upstream errors", async () => {
    await expect(make(() => json({ error: "refresh_token_reused" }, 400)).client.refresh(tokens)).rejects.toThrow(
      new ProviderAuthRequiredError("openai", "token endpoint rejected the grant (HTTP 400 refresh_token_reused)"),
    );
    await expect(make(() => ({ status: 401, body: "no" })).client.refresh(tokens)).rejects.toThrow(new ProviderAuthRequiredError("openai", "token endpoint rejected the grant (HTTP 401)"));
    await expect(make(() => json({ error: { code: 1 } }, 400)).client.refresh(tokens)).rejects.toThrow("(HTTP 400)");
    await expect(make(() => ({ status: 503, body: "busy" })).client.refresh(tokens)).rejects.toThrow(new UpstreamError("openai", 503, "busy"));
    await expect(make(() => ({ status: 200, body: "{oops" })).client.refresh(tokens)).rejects.toThrow(new UpstreamError("openai", 502, "token endpoint returned non-JSON: {oops"));
    await expect(make(() => json([1])).client.refresh(tokens)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("OpenAISession (H-a)", () => {
  test("renews under the openai lock through the OAuth client and stores the rotated tokens", async () => {
    const transport = new ScriptedTransport(() => json({ access_token: "a2", refresh_token: "r2", expires_in: 3600, scope: SCOPES }));
    const store = new MemoryCredentialStore();
    store.seed("openai", upsertAccount(EMPTY_POOL, toAccount({ ...tokens, expiresAt: NOW })));
    const lock = new RecordingLock();
    const oauth = new OpenAIOAuthClient(transport, store, new FixedIdentity(), new StubVerifier(), new FixedClock(NOW), "http://auth");
    const session = new OpenAISession(store, oauth, lock, new FixedClock(NOW), new MemoryLogger());
    const active = await session.active();
    expect([active.id, active.account.accessToken, active.account.refreshToken]).toEqual(["oaiapp_saved", "a2", "r2"]);
    expect(lock.acquired).toEqual([REFRESH_LOCK]);
    const stored = (await store.load("openai")).accounts[0]!;
    expect([stored.label, fromAccount(stored)?.refreshToken]).toEqual(["e2e@example.com", "r2"]);
    store.seed("openai", upsertAccount(EMPTY_POOL, { provider: "openai", id: "x", label: "x", data: { broken: true } }));
    await expect(session.active()).rejects.toThrow("stored credential of x is unreadable");
  });
});

class FixedSession extends OAuthSessionPort<OpenAITokens> {
  failing: Error | undefined;
  client = "oaiapp_saved";
  async active(): Promise<Session<OpenAITokens>> {
    if (this.failing) throw this.failing;
    return { id: this.client, account: { ...tokens, clientId: this.client } };
  }
  async forceRenew(seen: Session<OpenAITokens>) {
    return seen;
  }
}

describe("OpenAICatalog (M1–M2)", () => {
  const live = { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list", context_window: 500_000 }] };
  const make = (answer: () => ScriptedResponse = () => json(live)) => {
    const transport = new ScriptedTransport(answer);
    const session = new FixedSession();
    const store = new MemoryKeyValueStore();
    const clock = new FixedClock(NOW);
    const logger = new MemoryLogger();
    return { transport, session, store, clock, logger, catalog: new OpenAICatalog(transport, session, store, clock, logger, "http://api") };
  };

  test("live list (bearer, user agent), cached per registration for 24 h, then refreshed", async () => {
    const m = make();
    expect(await m.catalog.listing()).toEqual({ source: "live", entries: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 500_000 }] });
    expect(m.transport.requests[0]).toMatchObject({ method: "GET", url: "http://api/v1/models", headers: { authorization: "Bearer at", accept: "application/json", "user-agent": "inference-router/0.1.0" } });
    expect((await m.catalog.listing()).source).toBe("live");
    expect(m.store.values.get(CATALOG_KEY)).toMatchObject({ version: 1, clientId: "oaiapp_saved", fetchedAt: NOW });
    const restarted = new OpenAICatalog(m.transport, m.session, m.store, m.clock, m.logger, "http://api");
    expect((await restarted.listing()).source).toBe("cache");
    m.clock.time += 24 * 60 * 60 * 1000;
    expect((await m.catalog.listing()).source).toBe("live");
    expect(m.transport.requests).toHaveLength(2);
    m.session.client = "oaiapp_other";
    expect((await m.catalog.listing()).source).toBe("live");
    expect(m.transport.requests).toHaveLength(3);
  });

  test("no account → built-in list; a failing or empty live list → stored copy, else built-in; cache faults are warned", async () => {
    const none = make();
    none.session.failing = new ProviderAuthRequiredError("openai", "no active account");
    expect(await none.catalog.listing()).toEqual({ source: "static", entries: STATIC_CATALOG });
    expect(none.logger.lines).toEqual(["WARN openai: live model list unavailable (openai: no active account; run `inference-router login openai`)"]);

    const failing = make(() => ({ status: 500, body: "x" }));
    expect((await failing.catalog.listing()).source).toBe("static");
    failing.store.values.set(CATALOG_KEY, { version: 1, clientId: "oaiapp_saved", fetchedAt: 0, models: [{ id: "old", displayName: "Old" }] });
    expect(await failing.catalog.listing()).toEqual({ source: "cache", entries: [{ id: "old", displayName: "Old" }] });
    expect(failing.logger.lines).toContain("WARN openai: live model list unavailable (model list HTTP 500)");

    const empty = make(() => json({ models: [] }));
    expect((await empty.catalog.listing()).source).toBe("static");
    expect(empty.logger.lines).toEqual(["WARN openai: live model list unavailable (live model list is empty)"]);

    const faults = make();
    faults.store.failRead = new Error("eio");
    faults.store.failWrite = new Error("rofs");
    expect((await faults.catalog.listing()).source).toBe("live");
    expect(faults.logger.lines).toEqual(["WARN openai: model list cache unreadable: Error: eio", "WARN openai: model list cache write failed: Error: rofs"]);
  });
});

class FixedCatalog extends OpenAICatalogPort {
  async listing(): Promise<CatalogListing> {
    return { source: "live", entries: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 500_000 }, { id: "gpt-5.5", displayName: "gpt-5.5" }] };
  }
}

const sse = (...events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = { id: "resp_1", object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] };
const STREAM = sse({ type: "response.created", response: { id: "resp_1" } }, { type: "response.output_text.delta", delta: "Hello" }, { type: "response.completed", response: completed });

describe("OpenAIProvider (I1–I5, E1–E3, O7–O9)", () => {
  const make = (answer: () => ScriptedResponse = () => ({ status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_1", "set-cookie": "x" }, body: [STREAM.slice(0, 40), STREAM.slice(40)] })) => {
    const transport = new ScriptedTransport(answer);
    const logger = new MemoryLogger();
    return { transport, logger, provider: new OpenAIProvider(new FixedSession(), new FixedCatalog(), new FixedIdentity(), transport, logger, "http://api") };
  };
  const raw = (body: unknown, headers: Record<string, string> = {}, lossy = false, path = NATIVE_PATH): RawRequest => ({ format: "openai-responses", path, query: {}, headers, body: typeof body === "string" ? body : JSON.stringify(body), lossy });

  test("identity, models, and the translated cells (P5)", async () => {
    const { provider } = make();
    expect([provider.id, [...(await provider.nativeFormats("any"))], provider.capabilities().size]).toEqual(["openai", ["openai-responses"], 0]);
    expect(await provider.models()).toEqual({
      provider: "openai",
      formats: ["openai-responses"],
      source: "live",
      models: [
        { address: { provider: "openai", model: "gpt-6.1-sol" }, displayName: "GPT-6.1 Sol", contextWindow: 500_000 },
        { address: { provider: "openai", model: "gpt-5.5" }, displayName: "gpt-5.5" },
      ],
    });
    await expect(provider.countTokens({} as never)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(provider.stream({} as never)[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  test("a streaming client gets the upstream stream unchanged; the request is store false / stream true with opencode's session headers", async () => {
    const { provider, transport, logger } = make();
    const res = await provider.passthrough("gpt-6.1-sol", raw({ model: "openai/gpt-6.1-sol", input: "hi", stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "content-type": "text/event-stream", "x-request-id": "req_1" });
    expect(await readAll(res.body)).toBe(STREAM);
    const sent = transport.requests[0]!;
    expect([sent.method, sent.url]).toEqual(["POST", "http://api/v1/responses"]);
    expect(sent.headers).toEqual({
      authorization: "Bearer at",
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": "inference-router/0.1.0",
      "session-id": "proc-session",
      "thread-id": "proc-session",
      "x-client-request-id": "proc-session",
    });
    expect(JSON.parse(sent.body!)).toEqual({ model: "gpt-6.1-sol", input: [{ role: "user", content: "hi" }], stream: true, store: false });
    expect(logger.lines).toEqual(["INFO openai: /v1/responses model=gpt-6.1-sol (stream) -> HTTP 200", "INFO openai: stream end model=gpt-6.1-sol terminal=response.completed"]);
  });

  test("I6: the terminal response gets the streamed output items (stream and aggregated), split across chunks", async () => {
    const item = { type: "message", content: [{ type: "output_text", text: "OK" }] };
    const upstream = sse({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "r", output: [] } });
    const answer = () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: [upstream.slice(0, 50), upstream.slice(50, 51), upstream.slice(51)] });
    const streamed = await readAll((await make(answer).provider.passthrough("m", raw({ input: [], stream: true }))).body);
    expect(streamed).toBe(sse({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "r", output: [item] } }));
    expect(JSON.parse(await readAll((await make(answer).provider.passthrough("m", raw({ input: [] }))).body))).toEqual({ id: "r", output: [item] });
    const unterminated = await readAll((await make(() => ({ status: 200, headers: {}, body: "data: 1" })).provider.passthrough("m", raw({ input: [], stream: true }))).body);
    expect(unterminated).toBe("data: 1");
  });

  test("a client that stops reading after the terminal event still gets the log line", async () => {
    const { provider, logger } = make();
    const body = (await provider.passthrough("m", raw({ input: [], stream: true }))).body[Symbol.asyncIterator]();
    await body.next();
    await body.return!();
    expect(logger.lines.at(-1)).toBe("INFO openai: stream closed by the client model=m terminal=response.completed");
  });

  test("a stream without a terminal event is passed on and logged as such", async () => {
    const { provider, logger } = make(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "response.created", response: {} }) }));
    await readAll((await provider.passthrough("m", raw({ input: [], stream: true }))).body);
    expect(logger.lines.at(-1)).toBe("INFO openai: stream end model=m terminal=none");
  });

  test("the client's own session headers are forwarded", async () => {
    const { provider, transport } = make();
    await readAll((await provider.passthrough("m", raw({ input: [], stream: true }, { "session-id": "s", "thread-id": "t", "x-client-request-id": "r" }))).body);
    expect(transport.requests[0]!.headers).toMatchObject({ "session-id": "s", "thread-id": "t", "x-client-request-id": "r" });
    await readAll((await provider.passthrough("m", raw({ input: [], stream: true }, { "session-id": "s" }))).body);
    expect(transport.requests[1]!.headers).toMatchObject({ "session-id": "s", "thread-id": "s", "x-client-request-id": "s" });
  });

  test("a non-streaming client gets the completed response as one JSON body (O8); lossy drops are reported", async () => {
    const { provider, logger } = make();
    const res = await provider.passthrough("m", raw({ input: [], temperature: 0 }, {}, true));
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", "x-request-id": "req_1", [DROPPED_HEADER]: "temperature" });
    expect(JSON.parse(await readAll(res.body))).toEqual(completed);
    expect(logger.lines).toEqual(["INFO openai: /v1/responses model=m (aggregated) -> HTTP 200"]);
  });

  test("a failure after the stream opened is answered with the documented status of its code (non-streaming client)", async () => {
    const failed = sse({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } });
    const { provider, logger } = make(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: failed }));
    const res = await provider.passthrough("m", raw({ input: [] }));
    expect([res.status, res.headers]).toEqual([429, { "content-type": "application/json" }]);
    expect(JSON.parse(await readAll(res.body))).toEqual({ error: { message: "limit", type: "response_failed", param: null, code: "subscription_sharing_usage_limit_exceeded" } });
    expect(logger.lines[1]).toBe("WARN openai: model=m failed after the stream opened: HTTP 429");
  });

  test("upstream errors before the stream pass through with status, body and retry-after", async () => {
    const { provider } = make(() => json({ detail: "Unauthorized" }, 401, { "retry-after": "7" }));
    const res = await provider.passthrough("m", raw({ input: [], stream: true }));
    expect([res.status, res.headers]).toEqual([401, { "content-type": "application/json", "retry-after": "7" }]);
    expect(await readAll(res.body)).toBe('{"detail":"Unauthorized"}');
  });

  test("invalid requests: strict unsupported fields", async () => {
    const { provider, transport } = make();
    await expect(provider.passthrough("m", raw({ input: [], user: "u" }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(transport.requests).toHaveLength(0);
  });

  test("helpers: forwarded headers and SSE event parsing", () => {
    expect(forwardedResponseHeaders({ "Content-Type": "a", "Retry-After": "1", "X-Request-Id": "r", other: "x" })).toEqual({ "content-type": "a", "retry-after": "1", "x-request-id": "r" });
    expect(sseEvents('data: {"type":"a"}\n\ndata: [DONE]\n\ndata: 3\n\ndata: {"type":"b"}')).toEqual([{ type: "a" }, { type: "b" }]);
  });
});
