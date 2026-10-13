import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import type { DeviceAuthorization } from "@inference-router/core/domain/device-flow.ts";
import { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { OpencodeCatalogSource } from "@inference-router/provider-opencode/adapters/outbound/opencode-catalog-source.ts";
import { OpencodeConsoleClient } from "@inference-router/provider-opencode/adapters/outbound/opencode-console-client.ts";
import { OpencodeDeviceLogin, OpencodeKeyLogin } from "@inference-router/provider-opencode/adapters/outbound/opencode-logins.ts";
import { ConsoleGatewaySession, ConsoleSession, EXPIRY_BUFFER_MS, REFRESH_LOCK } from "@inference-router/provider-opencode/adapters/outbound/opencode-session.ts";
import { encodeDevice, type ConsoleTokens, type WorkspaceHeaders } from "@inference-router/provider-opencode/domain/opencode.ts";
import { ConsoleApiPort, type ConsoleAuth, type TokenPoll } from "@inference-router/provider-opencode/ports/outbound/console.ts";
import { FixedClock, MemoryCredentialStore, MemoryLogger, RecordingLock, ScriptedTransport } from "@inference-router/test-support/fakes.ts";

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([1, 2, 3, 4]);
  }
}

const CONSOLE = "http://gw/console";
const LIST = JSON.stringify({ object: "list", data: [{ id: "big-pickle" }, { id: "new" }] });
const MODELS_DEV = JSON.stringify({ opencode: { npm: "@ai-sdk/openai-compatible", models: { "big-pickle": { name: "Big Pickle" } } } });
/** The Console API page's config example (opencode-console-api.html "Workspace config"). */
const CONFIG = JSON.stringify({ providers: { opencode: { name: "OpenCode", headers: { "x-opencode-org-id": "org_..." }, models: { "kimi-k2.6": { name: "Kimi K2.6" } } } } });
const AUTHORIZATION: DeviceAuthorization = { deviceCode: "dc", userCode: "U", verificationUrl: "http://gw/console/device", intervalMs: 5000, expiresInMs: 600_000 };
const TOKENS: ConsoleTokens = { accessToken: "at", refreshToken: "rt", expiresAt: 1_800_000_000_000 + 3_600_000, orgId: "org_1" };

describe("OpencodeCatalogSource (Z4, Z5, Z12, Z13)", () => {
  test("the Console's ids described by models.dev", async () => {
    const transport = new ScriptedTransport((r) => ({ status: 200, body: r.url.endsWith("/api.json") ? MODELS_DEV : LIST }));
    const source = new OpencodeCatalogSource("opencode", transport, new MemoryLogger(), "http://gw/inference", "http://md/api.json");
    expect(await source.fetch()).toEqual([
      { id: "big-pickle", displayName: "Big Pickle", formats: ["openai-chat"] },
      { id: "new", displayName: "new" },
    ]);
    expect(transport.requests.map((r) => [r.url, r.headers])).toEqual([
      ["http://gw/inference/v1/models", { accept: "application/json" }],
      ["http://md/api.json", { accept: "application/json" }],
    ]);
  });

  test("models.dev unavailable: the ids without formats, warned; the Console list failing fails the fetch", async () => {
    const logger = new MemoryLogger();
    const transport = new ScriptedTransport((r) => (r.url.endsWith("/api.json") ? { status: 502 } : { status: 200, body: LIST }));
    expect(await new OpencodeCatalogSource("opencode", transport, logger, "http://gw/inference", "http://md/api.json").fetch()).toEqual([
      { id: "big-pickle", displayName: "big-pickle" },
      { id: "new", displayName: "new" },
    ]);
    expect(logger.lines).toEqual(["WARN opencode: models.dev unavailable (GET http://md/api.json HTTP 502); model formats unknown"]);
    const down = new ScriptedTransport(() => ({ status: 500 }));
    await expect(new OpencodeCatalogSource("opencode-go", down, logger, "http://gw/inference/go", "http://md/api.json").fetch()).rejects.toThrow("GET http://gw/inference/go/v1/models HTTP 500");
  });
});

describe("OpencodeConsoleClient (Z17–Z20)", () => {
  const client = (handler: ConstructorParameters<typeof ScriptedTransport>[0]) => {
    const transport = new ScriptedTransport(handler);
    return { transport, api: new OpencodeConsoleClient(transport, new FixedClock(1000), CONSOLE) };
  };
  const form = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "inference-router/0.1.0" };

  test("device code: form-encoded under the router's client id with the workspace scope; errors and non-JSON answers fail", async () => {
    const body = JSON.stringify({ device_code: "dc", user_code: "U", verification_uri_complete: "/console/device?user_code=U", expires_in: 600, interval: 5 });
    const { transport, api } = client(() => ({ status: 200, body }));
    expect(await api.deviceCode()).toEqual({ deviceCode: "dc", userCode: "U", verificationUrl: "http://gw/console/device?user_code=U", intervalMs: 5000, expiresInMs: 600_000 });
    expect(transport.requests[0]).toEqual({ method: "POST", url: "http://gw/console/auth/device/code", headers: form, body: "client_id=inference-router&supports_org_scope=true", timeoutMs: 30_000 });
    await expect(client(() => ({ status: 503, body: "down" })).api.deviceCode()).rejects.toThrow("opencode upstream HTTP 503: down");
    await expect(client(() => ({ status: 200, body: "<html>" })).api.deviceCode()).rejects.toThrow("the device authorization answer lacks a field or names a non-HTTP page: {}");
    await expect(client(() => ({ status: 400, body: "<html>" })).api.deviceToken(AUTHORIZATION)).rejects.toThrow("device authorization ended: no error code");
  });

  test("device token: pending and slow_down (400), the tokens (200), anything else fails", async () => {
    const answers = [
      { status: 400, body: '{"error":"authorization_pending"}' },
      { status: 400, body: '{"error":"slow_down"}' },
      { status: 200, body: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, org_id: "org_1" }) },
      { status: 500, body: "boom" },
      { status: 400, body: '{"error":"expired_token"}' },
    ];
    const { transport, api } = client((_, i) => answers[i]!);
    const polls: TokenPoll[] = [];
    for (let i = 0; i < 3; i += 1) polls.push(await api.deviceToken(AUTHORIZATION));
    expect(polls).toEqual([{ kind: "pending" }, { kind: "slow_down" }, { kind: "tokens", tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 3_601_000, orgId: "org_1" } }]);
    expect(transport.requests[0]!.body).toBe("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc&client_id=inference-router");
    await expect(api.deviceToken(AUTHORIZATION)).rejects.toBeInstanceOf(UpstreamError);
    await expect(api.deviceToken(AUTHORIZATION)).rejects.toThrow("device authorization ended: expired_token");
  });

  test("refresh: the single-use refresh token; the workspace kept when the answer omits it; invalid_grant needs a new login; other errors are upstream", async () => {
    const answers = [
      { status: 200, body: JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 60 }) },
      { status: 200, body: JSON.stringify({ access_token: "a3", refresh_token: "r3", expires_in: 60, org_id: "org_2" }) },
      { status: 400, body: '{"error":"invalid_grant"}' },
      { status: 400, body: '{"error":"invalid_request"}' },
      { status: 502, body: "bad gateway" },
    ];
    const { transport, api } = client((_, i) => answers[i]!);
    expect(await api.refresh(TOKENS)).toEqual({ accessToken: "a2", refreshToken: "r2", expiresAt: 61_000, orgId: "org_1" });
    expect(transport.requests[0]!.body).toBe("grant_type=refresh_token&refresh_token=rt&client_id=inference-router");
    expect((await api.refresh(TOKENS)).orgId).toBe("org_2");
    const rejected = api.refresh(TOKENS);
    await expect(rejected).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    await expect(api.refresh(TOKENS)).rejects.toThrow('opencode upstream HTTP 400: {"error":"invalid_request"}');
    await expect(api.refresh(TOKENS)).rejects.toThrow("opencode upstream HTTP 502: bad gateway");
  });

  test("identity: user and orgs with the access token; config: the key or the user token with x-org-id; 401/403 refuse the credential", async () => {
    const { transport, api } = client((r) => {
      if (r.url.endsWith("/api/user")) return { status: 200, body: '{"id":"u1","email":"me@x"}' };
      if (r.url.endsWith("/api/orgs")) return { status: 200, body: '[{"id":"org_1","name":"Team"}]' };
      return { status: 200, body: CONFIG };
    });
    expect(await api.identity(TOKENS)).toEqual({ id: "me@x/org_1", label: "me@x (Team)" });
    expect(await api.workspaceHeaders({ kind: "key", key: "oc_sk_1" })).toEqual({ opencode: { "x-opencode-org-id": "org_..." } });
    await api.workspaceHeaders({ kind: "user", accessToken: "at", orgId: "org_1" });
    await api.workspaceHeaders({ kind: "user", accessToken: "at", orgId: undefined });
    expect(transport.requests.map((r) => [r.method, r.url, r.headers])).toEqual([
      ["GET", "http://gw/console/api/user", { accept: "application/json", "user-agent": "inference-router/0.1.0", authorization: "Bearer at" }],
      ["GET", "http://gw/console/api/orgs", { accept: "application/json", "user-agent": "inference-router/0.1.0", authorization: "Bearer at" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "inference-router/0.1.0", authorization: "Bearer oc_sk_1" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "inference-router/0.1.0", authorization: "Bearer at", "x-org-id": "org_1" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "inference-router/0.1.0", authorization: "Bearer at" }],
    ]);
    const key: ConsoleAuth = { kind: "key", key: "k" };
    await expect(client(() => ({ status: 401, body: '{"_tag":"Unauthorized"}' })).api.workspaceHeaders(key)).rejects.toThrow('opencode: the Console refused the credential: HTTP 401 {"_tag":"Unauthorized"}');
    await expect(client(() => ({ status: 403, body: '{"_tag":"Forbidden"}' })).api.workspaceHeaders(key)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    await expect(client(() => ({ status: 404, body: '{"_tag":"NotFound"}' })).api.workspaceHeaders(key)).rejects.toThrow("opencode upstream HTTP 404");
  });
});

/** A Console API whose answers the test sets. */
class Api extends ConsoleApiPort {
  refreshes: ConsoleTokens[] = [];
  configs: ConsoleAuth[] = [];
  polls: TokenPoll[] = [];
  headers: WorkspaceHeaders = { opencode: { "x-opencode-org-id": "org_1" } };
  refreshAnswer: () => Promise<ConsoleTokens> = async () => ({ ...TOKENS, accessToken: "at2", refreshToken: "rt2", expiresAt: TOKENS.expiresAt + 3_600_000 });
  async deviceCode() {
    return AUTHORIZATION;
  }
  async deviceToken() {
    return this.polls.shift()!;
  }
  async refresh(tokens: ConsoleTokens) {
    this.refreshes.push(tokens);
    return this.refreshAnswer();
  }
  async identity() {
    return { id: "me@x/org_1", label: "me@x (Team)" };
  }
  async workspaceHeaders(auth: ConsoleAuth) {
    this.configs.push(auth);
    return this.headers;
  }
}

describe("OpencodeDeviceLogin and OpencodeKeyLogin (K1–K4)", () => {
  test("device: start, pending and slow_down passed on, then the account with the workspace headers under the owner (opencode)", async () => {
    const api = new Api();
    api.polls = [{ kind: "pending" }, { kind: "slow_down" }, { kind: "tokens", tokens: TOKENS }];
    const login = new OpencodeDeviceLogin("opencode-go", api);
    expect(login.provider).toBe("opencode-go");
    expect(await login.start()).toBe(AUTHORIZATION);
    expect(await login.poll(AUTHORIZATION)).toEqual({ kind: "pending" });
    expect(await login.poll(AUTHORIZATION)).toEqual({ kind: "slow_down" });
    expect(await login.poll(AUTHORIZATION)).toEqual({
      kind: "approved",
      account: { provider: "opencode", id: "me@x/org_1", label: "me@x (Team)", data: encodeDevice(TOKENS, api.headers) },
    });
    expect(api.configs).toEqual([{ kind: "user", accessToken: "at", orgId: "org_1" }]);
  });

  test("key: checked by reading the workspace config; stored under the owner with the headers; a refusal fails", async () => {
    const api = new Api();
    const login = new OpencodeKeyLogin("opencode-go", new Hash(), api);
    expect(login.question).toBe("OpenCode Console API key (opencode.ai Console → Keys → service account → Add API Key; starts oc_sk_): ");
    expect(await login.account(" oc_sk_1 ")).toEqual({ provider: "opencode", id: "key-01020304", label: "key-01020304", data: { workspaceHeaders: api.headers, apiKey: "oc_sk_1" } });
    expect(api.configs).toEqual([{ kind: "key", key: "oc_sk_1" }]);
    api.workspaceHeaders = () => Promise.reject(new ProviderAuthRequiredError("opencode", "the Console refused the credential: HTTP 401"));
    await expect(login.account("oc_sk_2")).rejects.toBeInstanceOf(ProviderAuthRequiredError);
  });
});

describe("ConsoleSession and ConsoleGatewaySession (K2, Z18)", () => {
  const device = (tokens: ConsoleTokens): AccountCredential => ({ provider: "opencode", id: "me@x/org_1", label: "me@x (Team)", data: encodeDevice(tokens, { opencode: { "x-opencode-org-id": "org_1" } }) });
  const setup = (credential: AccountCredential | undefined) => {
    const store = new MemoryCredentialStore();
    if (credential !== undefined) store.seed("opencode", upsertAccount(EMPTY_POOL, credential));
    const api = new Api();
    const lock = new RecordingLock();
    const clock = new FixedClock();
    const session = new ConsoleSession(store, api, lock, clock, new MemoryLogger());
    return { store, api, lock, clock, session, zen: new ConsoleGatewaySession("opencode", session, store), go: new ConsoleGatewaySession("opencode-go", session, store) };
  };

  test("a key is used as it is and never renewed; each provider gets its own workspace headers", async () => {
    const s = setup({ provider: "opencode", id: "key-1", label: "key-1", data: { apiKey: "oc_sk_1", workspaceHeaders: { opencode: { "x-opencode-org-id": "org_1" } } } });
    s.clock.time = Number.MAX_SAFE_INTEGER;
    expect(await s.zen.active()).toEqual({ accountId: "key-1", key: "oc_sk_1", headers: { "x-opencode-org-id": "org_1" } });
    expect(await s.go.active()).toEqual({ accountId: "key-1", key: "oc_sk_1", headers: {} });
    expect(await s.go.optionalKey()).toBe("oc_sk_1");
    expect([s.api.refreshes, s.lock.acquired]).toEqual([[], []]);
  });

  test("device tokens: used while fresh, renewed under the opencode-refresh lock inside the expiry buffer and stored", async () => {
    const s = setup(device(TOKENS));
    expect((await s.zen.active()).key).toBe("at");
    s.clock.time = TOKENS.expiresAt - EXPIRY_BUFFER_MS;
    expect(await s.zen.active()).toEqual({ accountId: "me@x/org_1", key: "at2", headers: { "x-opencode-org-id": "org_1" } });
    expect(s.lock.acquired).toEqual([REFRESH_LOCK]);
    expect(s.api.refreshes).toEqual([TOKENS]);
    const stored = (await s.store.load("opencode")).accounts[0]!;
    expect(stored).toEqual({ ...device(TOKENS), data: encodeDevice({ ...TOKENS, accessToken: "at2", refreshToken: "rt2", expiresAt: TOKENS.expiresAt + 3_600_000 }, { opencode: { "x-opencode-org-id": "org_1" } }) });
  });

  test("a rejected refresh marks the account needsLogin; no account: optionalKey is undefined and active needs a login", async () => {
    const s = setup(device(TOKENS));
    s.clock.time = TOKENS.expiresAt;
    s.api.refreshAnswer = () => Promise.reject(new ProviderAuthRequiredError("opencode", "the Console rejected the refresh token (invalid_grant)"));
    await expect(s.go.active()).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect((await s.store.load("opencode")).accounts[0]!.needsLogin).toBe("the Console rejected the refresh token (invalid_grant)");
    const empty = setup(undefined);
    expect(await empty.zen.optionalKey()).toBeUndefined();
    await expect(empty.zen.active()).rejects.toThrow("opencode: no active account; run `inference-router login opencode`");
  });
});
