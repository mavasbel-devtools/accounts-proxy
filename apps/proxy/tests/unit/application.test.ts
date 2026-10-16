import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount, type AccountCredential, markNeedsLogin } from "@accounts-proxy/core/domain/accounts.ts";
import { InvalidRequestError, ProviderAuthRequiredError, ProviderDisabledError, UnknownAccountError } from "@accounts-proxy/core/domain/errors.ts";
import type { ModelCatalog, ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { ListModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { ModelReferencePort, type ReferenceListing } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import { apiKeyAccount } from "@accounts-proxy/core/domain/api-key.ts";
import { ApiKeyLoginPort, ForeignKeySourcePort, SecretPromptPort } from "@accounts-proxy/core/ports/outbound/api-key.ts";
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import { DeviceLoginClientPort, type DevicePoll } from "@accounts-proxy/core/ports/outbound/device.ts";
import { CallbackServerFactoryPort, CallbackServerPort, ManualCodePort, OAuthClientPort, type AuthorizeInput, type CallbackQuery, type ExchangeInput } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import { BrowserLauncherPort, HashPort, TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { UsageReporterPort } from "@accounts-proxy/core/ports/outbound/usage.ts";
import { FixedClock, MemoryCredentialStore, MemoryLogger, SequenceRandom } from "@accounts-proxy/test-support/fakes.ts";
import { AccountAdminService, UsageService } from "@accounts-proxy/proxy/application/account-services.ts";
import { DescribeModelsService } from "@accounts-proxy/proxy/application/describe-models-service.ts";
import { ListModelsService } from "@accounts-proxy/proxy/application/list-models-service.ts";
import { LoginService } from "@accounts-proxy/proxy/application/login-service.ts";
import type { LoginOptions } from "@accounts-proxy/core/ports/inbound/accounts.ts";

class FakeClient extends OAuthClientPort {
  readonly callbackPath = "/cb";
  authorizations: AuthorizeInput[] = [];
  exchanges: ExchangeInput[] = [];
  failExchange = false;
  constructor(
    readonly provider: ProviderId,
    readonly manualRedirectUri: string | undefined,
  ) {
    super();
  }
  noRedirect = false;
  async authorizeUrl(input: AuthorizeInput): Promise<string> {
    this.authorizations.push(input);
    return `https://auth.example/?state=${input.state}`;
  }
  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    this.exchanges.push(input);
    if (this.failExchange) throw new ProviderAuthRequiredError(this.provider, "token endpoint rejected the grant (HTTP 400)");
    return { provider: this.provider, id: "me@x", label: "Me", data: { t: 1 } };
  }
  successRedirect(): string | undefined {
    return this.noRedirect ? undefined : "https://done.example/";
  }
}

class FakeServer extends CallbackServerPort {
  started = "";
  finished: unknown[] = [];
  stopped = false;
  constructor(private readonly query: (state: string) => CallbackQuery, private readonly stateOf: () => string) {
    super();
  }
  async start(path: string) {
    this.started = path;
    return 5555;
  }
  async waitForCallback() {
    return this.query(this.stateOf());
  }
  async finish(answer: unknown) {
    this.finished.push(answer);
  }
  async stop() {
    this.stopped = true;
  }
}

class Factory extends CallbackServerFactoryPort {
  last: FakeServer | undefined;
  constructor(private readonly make: () => FakeServer) {
    super();
  }
  create() {
    this.last = this.make();
    return this.last;
  }
}

class FakeBrowser extends BrowserLauncherPort {
  opened: string[] = [];
  fail = false;
  async open(url: string) {
    this.opened.push(url);
    if (this.fail) throw new Error("no browser");
  }
}

class FakeManual extends ManualCodePort {
  constructor(private readonly answer: (url: string) => string) {
    super();
  }
  async prompt(url: string) {
    return this.answer(url);
  }
}

class FakeKeyLogin extends ApiKeyLoginPort {
  readonly question = "key: ";
  keys: string[] = [];
  constructor(readonly provider: ProviderId) {
    super();
  }
  async account(key: string) {
    this.keys.push(key);
    if (key === "bad") throw new ProviderAuthRequiredError(this.provider, "the key was refused");
    return apiKeyAccount(this.provider, `id-${key}`, `label-${key}`, key);
  }
}

class FakeSecrets extends SecretPromptPort {
  questions: string[] = [];
  constructor(private readonly answers: string[]) {
    super();
  }
  async prompt(question: string) {
    this.questions.push(question);
    return this.answers.shift()!;
  }
}

class FakeDevice extends DeviceLoginClientPort {
  polls = 0;
  constructor(
    readonly provider: ProviderId,
    private readonly answers: DevicePoll[],
    readonly authorization: DeviceAuthorization = { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUrl: "https://opencode.ai/console/device?user_code=ABCD-EFGH", intervalMs: 5000, expiresInMs: 600_000 },
  ) {
    super();
  }
  async start() {
    return this.authorization;
  }
  async poll(authorization: DeviceAuthorization) {
    expect(authorization).toBe(this.authorization);
    this.polls += 1;
    return this.answers.shift()!;
  }
}

class FakeKeySource extends ForeignKeySourcePort {
  readonly tool = "opencode";
  entries: ProviderId[] = [];
  async apiKey(entry: ProviderId) {
    this.entries.push(entry);
    return `imported-${entry}`;
  }
}

/** Advances the clock by each sleep. */
class ClockTimer extends TimerPort {
  readonly sleeps: number[] = [];
  constructor(private readonly clock: FixedClock) {
    super();
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.clock.time += ms;
  }
}

class FixedHash extends HashPort {
  sha256(input: string) {
    return new TextEncoder().encode(`h(${input})`);
  }
}

function setup(
  client: FakeClient | undefined,
  query: (state: string) => CallbackQuery = (state) => ({ code: "c0de", state }),
  keyClients: ApiKeyLoginPort[] = [],
  secrets = new FakeSecrets([]),
  devices: DeviceLoginClientPort[] = [],
) {
  let state = "";
  const factory = new Factory(() => new FakeServer(query, () => state));
  const browser = new FakeBrowser();
  const store = new MemoryCredentialStore();
  const logger = new MemoryLogger();
  const manual = new FakeManual((url) => `pasted#${new URL(url).searchParams.get("state")}`);
  const clock = new FixedClock(0);
  const timer = new ClockTimer(clock);
  const keySource = new FakeKeySource();
  const service = new LoginService({
    clients: client === undefined ? [] : [client],
    devices,
    keyClients,
    keySources: [keySource],
    servers: factory,
    browser,
    manual,
    secrets,
    store,
    random: new SequenceRandom(),
    hash: new FixedHash(),
    clock,
    timer,
    logger,
  });
  const urls: string[] = [];
  const codes: string[] = [];
  const options: LoginOptions = { manual: false, fresh: false, key: false, importFrom: undefined, timeoutMs: 1000, onAuthorizeUrl: (u: string) => void urls.push(u), onUserCode: (c) => void codes.push(c) };
  const capture = () => {
    state = client?.authorizations.at(-1)?.state ?? "";
  };
  return { factory, browser, store, logger, service, urls, codes, options, capture, timer, keySource };
}

describe("LoginService", () => {
  test("loopback login with PKCE: announce, open browser, validate state, exchange, store, redirect", async () => {
    const client = new FakeClient("claude", "https://manual/cb");
    const s = setup(client);
    const run = s.service.login("claude", { ...s.options, onAuthorizeUrl: (u) => (s.capture(), void s.urls.push(u)) });
    const summary = await run;
    expect(summary).toEqual({ provider: "claude", id: "me@x", label: "Me", active: true });
    const auth = client.authorizations[0]!;
    expect(auth.redirectUri).toBe("http://localhost:5555/cb");
    expect(auth.state).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(auth.codeChallenge).toBe("aChBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4KQ");
    expect([auth.nonce, auth.fresh]).toEqual(["AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", false]);
    expect(client.exchanges[0]).toEqual({
      code: "c0de",
      state: auth.state,
      redirectUri: "http://localhost:5555/cb",
      codeVerifier: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      nonce: auth.nonce,
      callback: { code: "c0de", state: auth.state },
    });
    expect(s.urls).toEqual([`https://auth.example/?state=${auth.state}`]);
    expect(s.browser.opened).toEqual(s.urls);
    expect(s.factory.last!.started).toBe("/cb");
    expect(s.factory.last!.finished).toEqual([{ redirect: "https://done.example/" }]);
    expect(s.factory.last!.stopped).toBe(true);
    expect((await s.store.load("claude")).activeId).toBe("me@x");
    expect(s.logger.lines).toEqual(["INFO claude: signed in account me@x"]);
  });

  test("every client gets the PKCE pair (it sends it only if its official client does); a browser failure is only warned", async () => {
    const client = new FakeClient("antigravity", undefined);
    const s = setup(client);
    s.browser.fail = true;
    await s.service.login("antigravity", { ...s.options, onAuthorizeUrl: () => s.capture() });
    expect(client.authorizations[0]!.codeChallenge).toBeDefined();
    expect(client.exchanges[0]!.codeVerifier).toBeDefined();
    expect(s.logger.lines[0]).toBe("WARN antigravity: could not open the browser (Error: no browser); open the URL by hand");
  });

  test("a rejected callback (state mismatch) or exchange failure answers the browser with an error and stores nothing", async () => {
    const client = new FakeClient("antigravity", undefined);
    const bad = setup(client, () => ({ code: "c", state: "forged" }));
    await expect(bad.service.login("antigravity", bad.options)).rejects.toThrow("authorization state mismatch");
    expect(bad.factory.last!.finished).toEqual([{ status: 400, text: "Sign-in failed: antigravity: authorization state mismatch; run `accounts-proxy login antigravity`. Close this tab and retry." }]);
    expect(bad.factory.last!.stopped).toBe(true);
    expect(bad.store.saves).toBe(0);
    client.failExchange = true;
    const failing = setup(client);
    await expect(failing.service.login("antigravity", { ...failing.options, onAuthorizeUrl: () => failing.capture() })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect((failing.factory.last!.finished[0] as { status: number }).status).toBe(400);
  });

  test("a client without a success page gets a plain success answer; --new reaches the client", async () => {
    const client = new FakeClient("openai", undefined);
    client.noRedirect = true;
    const s = setup(client);
    await s.service.login("openai", { ...s.options, fresh: true, onAuthorizeUrl: () => s.capture() });
    expect(client.authorizations[0]!.fresh).toBe(true);
    expect(s.factory.last!.finished).toEqual([{ status: 200, text: "Signed in to openai as Me. You can close this tab." }]);
  });

  test("manual (paste-code) login uses the provider's manual redirect and PKCE", async () => {
    const client = new FakeClient("claude", "https://manual/cb");
    const s = setup(client);
    await s.service.login("claude", { ...s.options, manual: true });
    expect(client.exchanges[0]).toMatchObject({ code: "pasted", redirectUri: "https://manual/cb", callback: {} });
    expect(client.exchanges[0]!.codeVerifier).toBeDefined();
    expect(s.factory.last).toBeUndefined();
    expect(s.urls).toHaveLength(1);
  });

  test("manual login is refused for providers without a paste-code page; disabled providers are refused", async () => {
    const s = setup(new FakeClient("antigravity", undefined));
    await expect(s.service.login("antigravity", { ...s.options, manual: true })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(s.service.login("claude", s.options)).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});

describe("AccountAdminService and UsageService", () => {
  const credential = (id: string): AccountCredential => ({ provider: "antigravity", id, label: id === "a" ? "Alpha" : id, data: {} });

  test("API-key login (plan P4.6 N4): hidden prompt, the provider's check, stored and active; flags refused; a refused key stores nothing", async () => {
    const keyLogin = new FakeKeyLogin("cheaper-inference");
    const secrets = new FakeSecrets(["ci_live_1", "bad"]);
    const s = setup(new FakeClient("claude", undefined), undefined, [keyLogin], secrets);
    expect(await s.service.login("cheaper-inference", s.options)).toEqual({ provider: "cheaper-inference", id: "id-ci_live_1", label: "label-ci_live_1", active: true });
    expect(secrets.questions).toEqual(["key: "]);
    expect((await s.store.load("cheaper-inference")).activeId).toBe("id-ci_live_1");
    expect(s.browser.opened).toEqual([]);
    expect(s.logger.lines.at(-1)).toBe("INFO cheaper-inference: signed in account id-ci_live_1");
    await expect(s.service.login("cheaper-inference", { ...s.options, manual: true })).rejects.toThrow("cheaper-inference signs in with an API key; --manual and --new do not apply");
    await expect(s.service.login("cheaper-inference", { ...s.options, fresh: true })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(s.service.login("cheaper-inference", s.options)).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect((await s.store.load("cheaper-inference")).accounts).toHaveLength(1);
  });

  test("--key prompts even where a browser login exists; --from-opencode imports instead of prompting; providers without a key login refuse both", async () => {
    const keyLogin = new FakeKeyLogin("openrouter");
    const secrets = new FakeSecrets(["sk-or-1"]);
    const s = setup(new FakeClient("openrouter", undefined), undefined, [keyLogin], secrets);
    expect((await s.service.login("openrouter", { ...s.options, key: true })).id).toBe("id-sk-or-1");
    expect(s.factory.last).toBeUndefined();
    expect((await s.service.login("openrouter", { ...s.options, importFrom: "opencode" })).id).toBe("id-imported-openrouter");
    expect(s.keySource.entries).toEqual(["openrouter"]);
    expect(keyLogin.keys).toEqual(["sk-or-1", "imported-openrouter"]);
    expect(s.logger.lines).toContain("INFO openrouter: API key imported from opencode");
    await expect(s.service.login("openrouter", { ...s.options, key: true, manual: true })).rejects.toThrow("openrouter signs in with an API key; --manual and --new do not apply");
    const claude = setup(new FakeClient("claude", undefined));
    await expect(claude.service.login("claude", { ...claude.options, key: true })).rejects.toThrow("claude has no API-key login");
    await expect(claude.service.login("claude", { ...claude.options, importFrom: "opencode" })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  test("device login (amendment A): code and page shown, browser opened, polled every interval (+5 s after slow_down), stored under the owner", async () => {
    const account = { provider: "opencode" as const, id: "me@x/org_1", label: "me@x (Team)", data: {} };
    const device = new FakeDevice("opencode-go", [{ kind: "pending" }, { kind: "slow_down" }, { kind: "pending" }, { kind: "approved", account }]);
    const s = setup(undefined, undefined, [new FakeKeyLogin("opencode-go")], new FakeSecrets([]), [device]);
    expect(await s.service.login("opencode-go", { ...s.options, timeoutMs: 60_000 })).toEqual({ provider: "opencode-go", id: "me@x/org_1", label: "me@x (Team)", active: true });
    expect(s.codes).toEqual(["ABCD-EFGH"]);
    expect(s.urls).toEqual(["https://opencode.ai/console/device?user_code=ABCD-EFGH"]);
    expect(s.browser.opened).toEqual(s.urls);
    expect(s.timer.sleeps).toEqual([5000, 5000, 10_000, 10_000]);
    expect((await s.store.load("opencode")).activeId).toBe("me@x/org_1");
    expect((await s.store.load("opencode-go")).accounts).toEqual([]);
  });

  test("device login: the deadline is the shorter of the code's expiry and the login timeout; --manual/--new refused; a browser failure is only warned", async () => {
    const pending = (): DevicePoll[] => Array.from({ length: 10 }, () => ({ kind: "pending" }));
    const slow = new FakeDevice("opencode", pending());
    const s = setup(undefined, undefined, [], new FakeSecrets([]), [slow]);
    s.browser.fail = true;
    await expect(s.service.login("opencode", { ...s.options, timeoutMs: 12_000 })).rejects.toThrow("opencode: the device code was not approved in time");
    expect(slow.polls).toBe(2);
    expect(s.logger.lines[0]).toBe("WARN opencode: could not open the browser (Error: no browser); open the URL by hand");
    const expiring = new FakeDevice("opencode", pending(), { deviceCode: "d", userCode: "U", verificationUrl: "https://x/", intervalMs: 5000, expiresInMs: 7000 });
    const t = setup(undefined, undefined, [], new FakeSecrets([]), [expiring]);
    await expect(t.service.login("opencode", { ...t.options, timeoutMs: 600_000 })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(expiring.polls).toBe(1);
    await expect(t.service.login("opencode", { ...t.options, manual: true })).rejects.toThrow("opencode signs in with a device code; --manual and --new do not apply");
    expect(t.store.saves).toBe(0);
  });

  test("list marks the active account; use switches it and persists", async () => {
    const store = new MemoryCredentialStore();
    store.pools.set("antigravity", upsertAccount(upsertAccount(EMPTY_POOL, credential("a")), credential("b")));
    const admin = new AccountAdminService(store);
    expect(await admin.list("antigravity")).toEqual([
      { provider: "antigravity", id: "a", label: "Alpha", active: false },
      { provider: "antigravity", id: "b", label: "b", active: true },
    ]);
    expect(await admin.use("antigravity", "a")).toEqual({ provider: "antigravity", id: "a", label: "Alpha", active: true });
    expect((await store.load("antigravity")).activeId).toBe("a");
    await expect(admin.use("antigravity", "zz")).rejects.toBeInstanceOf(UnknownAccountError);
    expect(await admin.list("claude")).toEqual([]);
    store.seed("opencode", upsertAccount(EMPTY_POOL, { provider: "opencode", id: "k", label: "k", data: {} }));
    expect(await admin.list("opencode-go")).toEqual([{ provider: "opencode-go", id: "k", label: "k", active: true }]);
    expect((await admin.use("opencode-go", "k")).id).toBe("k");
    store.seed("antigravity", markNeedsLogin(await store.load("antigravity"), credential("b"), "grant rejected"));
    expect((await admin.list("antigravity"))[1]).toEqual({ provider: "antigravity", id: "b", label: "b", active: false, needsLogin: "grant rejected" });
  });

  test("usage: disabled, enabled without a reporter, and reported", async () => {
    class Reporter extends UsageReporterPort {
      readonly provider = "antigravity";
      async usage() {
        return { capturedAt: 1, text: "Antigravity usage:" };
      }
    }
    const usage = new UsageService(["claude", "antigravity"], [new Reporter()]);
    expect(await usage.usage("antigravity")).toEqual({ capturedAt: 1, text: "Antigravity usage:" });
    await expect(usage.usage("claude")).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(new UsageService([], []).usage("antigravity")).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});

describe("ListModelsService", () => {
  class Provider extends ProviderPort {
    constructor(readonly id: ProviderId) {
      super();
    }
    async nativeFormats() {
      return undefined;
    }
    capabilities() {
      return new Set<never>();
    }
    async models() {
      return { provider: this.id, formats: ["anthropic-messages"] as const, source: "live" as const, models: [{ address: { provider: this.id, model: `${this.id}-m` }, displayName: "M" }] };
    }
    async *stream() {}
    async countTokens() {
      return 0;
    }
    async passthrough(): Promise<never> {
      throw new Error("unused");
    }
  }
  test("all enabled providers, one provider, or disabled", async () => {
    const service = new ListModelsService([new Provider("claude"), new Provider("antigravity")]);
    expect((await service.listModels()).map((c) => c.models[0]!.address.model)).toEqual(["claude-m", "antigravity-m"]);
    expect((await service.listModels("antigravity")).map((c) => c.provider)).toEqual(["antigravity"]);
    await expect(new ListModelsService([]).listModels("antigravity")).rejects.toBeInstanceOf(ProviderDisabledError);
  });

  class Failing extends Provider {
    constructor(
      id: ProviderId,
      private readonly error: Error,
    ) {
      super(id);
    }
    override async models(): Promise<never> {
      throw this.error;
    }
  }

  test("all providers: one that cannot list is unavailable with its error; asked by name it fails; a bug is never hidden", async () => {
    const auth = new ProviderAuthRequiredError("antigravity", "no active account");
    const service = new ListModelsService([new Provider("claude"), new Failing("antigravity", auth)]);
    expect((await service.listModels())[1]).toEqual({ provider: "antigravity", formats: [], source: "unavailable", models: [], error: { code: "provider_auth_required", message: auth.message } });
    await expect(service.listModels("antigravity")).rejects.toBe(auth);
    await expect(new ListModelsService([new Failing("claude", new TypeError("boom"))]).listModels()).rejects.toThrow("boom");
  });
});

describe("DescribeModelsService", () => {
  class Models extends ListModelsPort {
    constructor(private readonly catalogs: readonly ModelCatalog[]) {
      super();
    }
    async listModels(provider?: ProviderId) {
      return this.catalogs.filter((c) => provider === undefined || c.provider === provider);
    }
  }
  class Reference extends ModelReferencePort {
    reads = 0;
    async reference(): Promise<ReferenceListing> {
      this.reads += 1;
      return { source: "cache", catalog: new Map([["anthropic", new Map([["c", { name: "Claude C", toolCall: true }]])]]) };
    }
  }
  const claude: ModelCatalog = { provider: "claude", formats: ["anthropic-messages"], source: "live", models: [{ address: { provider: "claude", model: "c" }, displayName: "c" }] };
  const cheaper: ModelCatalog = { provider: "cheaper-inference", formats: [], source: "live", models: [{ address: { provider: "cheaper-inference", model: "x" }, displayName: "x", formats: ["openai-chat"] }] };

  test("each catalog described with the reference; the reference is read only when a listed provider has one", async () => {
    const reference = new Reference();
    const service = new DescribeModelsService(new Models([claude, cheaper]), reference);
    const [c, x] = await service.describeModels();
    expect(c).toEqual({ provider: "claude", source: "live", referenceSource: "cache", models: [{ id: "claude/c", provider: "claude", model: "c", name: "Claude C", formats: ["anthropic-messages"], toolCall: true, sources: { name: "models.opencode.ai:anthropic/c", toolCall: "models.opencode.ai:anthropic/c" } }] });
    expect(x!.referenceSource).toBeUndefined();
    expect(reference.reads).toBe(1);
    await service.describeModels("cheaper-inference");
    expect(reference.reads).toBe(1);
  });
});
