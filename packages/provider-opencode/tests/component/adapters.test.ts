import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount, type AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import { ModelReferencePort, type ReferenceListing } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import { HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { OpencodeCatalogSource } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-catalog-source.ts";
import { OpencodeConsoleClient } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-console-client.ts";
import { OpencodeDeviceLogin, OpencodeKeyLogin } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-logins.ts";
import { ConsoleGatewaySession, ConsoleSession, EXPIRY_BUFFER_MS, REFRESH_LOCK } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-session.ts";
import { encodeDevice, type ConsoleTokens, type WorkspaceHeaders } from "@accounts-proxy/provider-opencode/domain/opencode.ts";
import { ConsoleApiPort, type ConsoleAuth, type TokenPoll } from "@accounts-proxy/provider-opencode/ports/outbound/console.ts";
import { FixedClock, MemoryCredentialStore, MemoryLogger, RecordingLock, ScriptedTransport } from "@accounts-proxy/test-support/fakes.ts";

class Hash extends HashPort {
  sha256() {
    return Uint8Array.from([1, 2, 3, 4]);
  }
}

const CONSOLE = "http://gw/console";
/** The Console API page's config example (opencode-console-api.html "Workspace config"). */
const CONFIG = JSON.stringify({ providers: { opencode: { name: "OpenCode", headers: { "x-opencode-org-id": "org_..." }, models: { "kimi-k2.6": { name: "Kimi K2.6" } } } } });
const AUTHORIZATION: DeviceAuthorization = { deviceCode: "dc", userCode: "U", verificationUrl: "http://gw/console/device", intervalMs: 5000, expiresInMs: 600_000 };
const TOKENS: ConsoleTokens = { accessToken: "at", refreshToken: "rt", expiresAt: 1_800_000_000_000 + 3_600_000, orgId: "org_1" };

class Reference extends ModelReferencePort {
  constructor(private readonly source: ReferenceListing["source"] = "live") {
    super();
  }
  async reference(): Promise<ReferenceListing> {
    return { source: this.source, catalog: new Map([["opencode", new Map([["big-pickle", { name: "Big Pickle", aiSdkPackage: "@ai-sdk/openai-compatible" }], ["new", {}]])]]) };
  }
}

describe("OpencodeCatalogSource (Z5, recon gap O5)", () => {
  test("the reference catalog's ids and formats, as OpenCode loads them; a model without a known package keeps none (Z6)", async () => {
    expect(await new OpencodeCatalogSource("opencode", new Reference()).fetch()).toEqual([
      { id: "big-pickle", displayName: "big-pickle", formats: ["openai-chat"] },
      { id: "new", displayName: "new" },
    ]);
    await expect(new OpencodeCatalogSource("opencode-go", new Reference()).fetch()).rejects.toThrow("the reference model catalog has no opencode-go provider");
  });

  test("a stored reference is the list; only the reference's built-in copy fails the fetch, so the gateway catalog uses its own stored or built-in copy", async () => {
    expect(await new OpencodeCatalogSource("opencode", new Reference("cache")).fetch()).toHaveLength(2);
    await expect(new OpencodeCatalogSource("opencode", new Reference("static")).fetch()).rejects.toThrow("the reference model catalog is unavailable (built-in copy only)");
  });
});

describe("OpencodeConsoleClient (Z17–Z20)", () => {
  const client = (handler: ConstructorParameters<typeof ScriptedTransport>[0]) => {
    const transport = new ScriptedTransport(handler);
    return { transport, api: new OpencodeConsoleClient(transport, new FixedClock(1000), CONSOLE) };
  };
  const form = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "accounts-proxy/0.1.0" };

  test("device code: form-encoded under the proxy's client id with the workspace scope; errors and non-JSON answers fail", async () => {
    const body = JSON.stringify({ device_code: "dc", user_code: "U", verification_uri_complete: "/console/device?user_code=U", expires_in: 600, interval: 5 });
    const { transport, api } = client(() => ({ status: 200, body }));
    expect(await api.deviceCode()).toEqual({ deviceCode: "dc", userCode: "U", verificationUrl: "http://gw/console/device?user_code=U", intervalMs: 5000, expiresInMs: 600_000 });
    expect(transport.requests[0]).toEqual({ method: "POST", url: "http://gw/console/auth/device/code", headers: form, body: "client_id=accounts-proxy&supports_org_scope=true", timeoutMs: 30_000 });
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
    expect(transport.requests[0]!.body).toBe("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc&client_id=accounts-proxy");
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
    expect(transport.requests[0]!.body).toBe("grant_type=refresh_token&refresh_token=rt&client_id=accounts-proxy");
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
      ["GET", "http://gw/console/api/user", { accept: "application/json", "user-agent": "accounts-proxy/0.1.0", authorization: "Bearer at" }],
      ["GET", "http://gw/console/api/orgs", { accept: "application/json", "user-agent": "accounts-proxy/0.1.0", authorization: "Bearer at" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "accounts-proxy/0.1.0", authorization: "Bearer oc_sk_1" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "accounts-proxy/0.1.0", authorization: "Bearer at", "x-org-id": "org_1" }],
      ["GET", "http://gw/console/api/v2/config", { accept: "application/json", "user-agent": "accounts-proxy/0.1.0", authorization: "Bearer at" }],
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
    await expect(empty.zen.active()).rejects.toThrow("opencode: no active account; run `accounts-proxy login opencode`");
  });
});
