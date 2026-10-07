import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, upsertAccount, type AccountCredential } from "../../../../packages/core/src/domain/accounts.ts";
import { InvalidRequestError, ProviderAuthRequiredError, ProviderDisabledError, UnknownAccountError } from "../../../../packages/core/src/domain/errors.ts";
import type { ProviderId } from "../../../../packages/core/src/domain/models.ts";
import { CallbackServerFactoryPort, CallbackServerPort, ManualCodePort, OAuthClientPort, type AuthorizeInput, type CallbackQuery, type ExchangeInput } from "../../../../packages/core/src/ports/outbound/oauth.ts";
import { ProviderPort } from "../../../../packages/core/src/ports/outbound/provider.ts";
import { BrowserLauncherPort, HashPort } from "../../../../packages/core/src/ports/outbound/system.ts";
import { UsageReporterPort } from "../../../../packages/core/src/ports/outbound/usage.ts";
import { MemoryCredentialStore, MemoryLogger, SequenceRandom } from "../../../../tests/support/fakes.ts";
import { AccountAdminService, UsageService } from "../../src/application/account-services.ts";
import { ListModelsService } from "../../src/application/list-models-service.ts";
import { LoginService } from "../../src/application/login-service.ts";

class FakeClient extends OAuthClientPort {
  readonly callbackPath = "/cb";
  authorizations: AuthorizeInput[] = [];
  exchanges: ExchangeInput[] = [];
  failExchange = false;
  constructor(
    readonly provider: ProviderId,
    readonly usesPkce: boolean,
    readonly manualRedirectUri: string | undefined,
  ) {
    super();
  }
  authorizeUrl(input: AuthorizeInput): string {
    this.authorizations.push(input);
    return `https://auth.example/?state=${input.state}`;
  }
  async exchange(input: ExchangeInput): Promise<AccountCredential> {
    this.exchanges.push(input);
    if (this.failExchange) throw new ProviderAuthRequiredError(this.provider, "token endpoint rejected the grant (HTTP 400)");
    return { provider: this.provider, id: "me@x", label: "Me", data: { t: 1 } };
  }
  successRedirect(): string {
    return "https://done.example/";
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

class FixedHash extends HashPort {
  sha256(input: string) {
    return new TextEncoder().encode(`h(${input})`);
  }
}

function setup(client: FakeClient, query: (state: string) => CallbackQuery = (state) => ({ code: "c0de", state })) {
  let state = "";
  const factory = new Factory(() => new FakeServer(query, () => state));
  const browser = new FakeBrowser();
  const store = new MemoryCredentialStore();
  const logger = new MemoryLogger();
  const manual = new FakeManual((url) => `pasted#${new URL(url).searchParams.get("state")}`);
  const service = new LoginService([client], factory, browser, manual, store, new SequenceRandom(), new FixedHash(), logger);
  const urls: string[] = [];
  const options = { manual: false, timeoutMs: 1000, onAuthorizeUrl: (u: string) => urls.push(u) };
  const capture = () => {
    state = client.authorizations.at(-1)?.state ?? "";
  };
  return { factory, browser, store, logger, service, urls, options, capture };
}

describe("LoginService", () => {
  test("loopback login with PKCE: announce, open browser, validate state, exchange, store, redirect", async () => {
    const client = new FakeClient("claude-subscription", true, "https://manual/cb");
    const s = setup(client);
    const run = s.service.login("claude-subscription", { ...s.options, onAuthorizeUrl: (u) => (s.capture(), s.urls.push(u)) });
    const summary = await run;
    expect(summary).toEqual({ provider: "claude-subscription", id: "me@x", label: "Me", active: true });
    const auth = client.authorizations[0]!;
    expect(auth.redirectUri).toBe("http://localhost:5555/cb");
    expect(auth.state).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(auth.codeChallenge).toBe("aChBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4KQ");
    expect(client.exchanges[0]).toEqual({ code: "c0de", state: auth.state, redirectUri: "http://localhost:5555/cb", codeVerifier: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" });
    expect(s.urls).toEqual([`https://auth.example/?state=${auth.state}`]);
    expect(s.browser.opened).toEqual(s.urls);
    expect(s.factory.last!.started).toBe("/cb");
    expect(s.factory.last!.finished).toEqual([{ redirect: "https://done.example/" }]);
    expect(s.factory.last!.stopped).toBe(true);
    expect((await s.store.load("claude-subscription")).activeId).toBe("me@x");
    expect(s.logger.lines).toEqual(["INFO claude-subscription: signed in account me@x"]);
  });

  test("no PKCE for clients that do not use it; a browser failure is only warned", async () => {
    const client = new FakeClient("antigravity", false, undefined);
    const s = setup(client);
    s.browser.fail = true;
    await s.service.login("antigravity", { ...s.options, onAuthorizeUrl: () => s.capture() });
    expect(client.authorizations[0]!.codeChallenge).toBeUndefined();
    expect(client.exchanges[0]!.codeVerifier).toBeUndefined();
    expect(s.logger.lines[0]).toBe("WARN antigravity: could not open the browser (Error: no browser); open the URL by hand");
  });

  test("a rejected callback (state mismatch) or exchange failure answers the browser with an error and stores nothing", async () => {
    const client = new FakeClient("antigravity", false, undefined);
    const bad = setup(client, () => ({ code: "c", state: "forged" }));
    await expect(bad.service.login("antigravity", bad.options)).rejects.toThrow("authorization state mismatch");
    expect(bad.factory.last!.finished).toEqual([{ status: 400, text: "Sign-in failed: antigravity: authorization state mismatch; run `inference-router login antigravity`. Close this tab and retry." }]);
    expect(bad.factory.last!.stopped).toBe(true);
    expect(bad.store.saves).toBe(0);
    client.failExchange = true;
    const failing = setup(client);
    await expect(failing.service.login("antigravity", { ...failing.options, onAuthorizeUrl: () => failing.capture() })).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect((failing.factory.last!.finished[0] as { status: number }).status).toBe(400);
  });

  test("a non-Error failure is rendered too", async () => {
    const client = new FakeClient("antigravity", false, undefined);
    client.exchange = () => Promise.reject("boom");
    const s = setup(client);
    await expect(s.service.login("antigravity", { ...s.options, onAuthorizeUrl: () => s.capture() })).rejects.toBe("boom");
    expect(s.factory.last!.finished).toEqual([{ status: 400, text: "Sign-in failed: boom. Close this tab and retry." }]);
  });

  test("manual (paste-code) login uses the provider's manual redirect and PKCE", async () => {
    const client = new FakeClient("claude-subscription", true, "https://manual/cb");
    const s = setup(client);
    await s.service.login("claude-subscription", { ...s.options, manual: true });
    expect(client.exchanges[0]).toMatchObject({ code: "pasted", redirectUri: "https://manual/cb" });
    expect(client.exchanges[0]!.codeVerifier).toBeDefined();
    expect(s.factory.last).toBeUndefined();
    expect(s.urls).toHaveLength(1);
    const noPkce = new FakeClient("claude-subscription", false, "https://manual/cb");
    const t = setup(noPkce);
    await t.service.login("claude-subscription", { ...t.options, manual: true });
    expect(noPkce.exchanges[0]!.codeVerifier).toBeUndefined();
  });

  test("manual login is refused for providers without a paste-code page; disabled providers are refused", async () => {
    const s = setup(new FakeClient("antigravity", false, undefined));
    await expect(s.service.login("antigravity", { ...s.options, manual: true })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(s.service.login("claude-subscription", s.options)).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});

describe("AccountAdminService and UsageService", () => {
  const credential = (id: string): AccountCredential => ({ provider: "antigravity", id, label: id === "a" ? "Alpha" : id, data: {} });

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
    expect(await admin.list("claude-subscription")).toEqual([]);
  });

  test("usage: disabled, enabled without a reporter, and reported", async () => {
    class Reporter extends UsageReporterPort {
      readonly provider = "antigravity";
      async usage() {
        return { capturedAt: 1, text: "Antigravity usage:" };
      }
    }
    const usage = new UsageService(["claude-subscription", "antigravity"], [new Reporter()]);
    expect(await usage.usage("antigravity")).toEqual({ capturedAt: 1, text: "Antigravity usage:" });
    await expect(usage.usage("claude-subscription")).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(new UsageService([], []).usage("antigravity")).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});

describe("ListModelsService", () => {
  class Provider extends ProviderPort {
    readonly nativeDialect = "anthropic";
    constructor(readonly id: ProviderId) {
      super();
    }
    capabilities() {
      return new Set<never>();
    }
    async models() {
      return [{ address: { provider: this.id, model: `${this.id}-m` }, displayName: "M" }];
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
    const service = new ListModelsService([new Provider("claude-subscription"), new Provider("antigravity")]);
    expect((await service.listModels()).map((m) => m.address.model)).toEqual(["claude-subscription-m", "antigravity-m"]);
    expect((await service.listModels("antigravity")).map((m) => m.address.model)).toEqual(["antigravity-m"]);
    await expect(new ListModelsService([]).listModels("antigravity")).rejects.toBeInstanceOf(ProviderDisabledError);
  });
});
