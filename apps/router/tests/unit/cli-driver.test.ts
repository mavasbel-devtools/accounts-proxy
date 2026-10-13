import { describe, expect, test } from "bun:test";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { ModelCatalog, ProviderId } from "@inference-router/core/domain/models.ts";
import { AccessPort } from "@inference-router/core/ports/inbound/access.ts";
import { AccountAdminPort, LoginPort, UsagePort, type AccountSummary, type LoginOptions } from "@inference-router/core/ports/inbound/accounts.ts";
import { DaemonStatusPort, type DaemonStatus } from "@inference-router/core/ports/inbound/daemon.ts";
import { HealthPort, ListModelsPort } from "@inference-router/core/ports/inbound/routing.ts";
import { CliDriver, DEFAULT_LOGIN_TIMEOUT_S, SHUTDOWN_GRACE_MS, USAGE } from "@inference-router/router/adapters/inbound/cli/cli-driver.ts";
import { Driver } from "@inference-router/router/adapters/inbound/driver.ts";
import { Server, ShutdownSignal, type Listening } from "@inference-router/router/adapters/inbound/server.ts";

class Login extends LoginPort {
  calls: [ProviderId, Omit<LoginOptions, "onAuthorizeUrl" | "onUserCode">][] = [];
  async login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary> {
    this.calls.push([provider, { manual: options.manual, fresh: options.fresh, key: options.key, importFrom: options.importFrom, timeoutMs: options.timeoutMs }]);
    if (provider === "opencode") options.onUserCode("ABCD-EFGH");
    options.onAuthorizeUrl("https://auth.example/");
    return { provider, id: "me@x", label: "Me", active: true };
  }
}
class Accounts extends AccountAdminPort {
  constructor(private readonly accounts: AccountSummary[]) {
    super();
  }
  async list() {
    return this.accounts;
  }
  async use(provider: ProviderId, id: string) {
    return { provider, id, label: id, active: true };
  }
}
class Usage extends UsagePort {
  async usage() {
    return { capturedAt: 1, text: "Antigravity usage:" };
  }
}
class Models extends ListModelsPort {
  seen: (ProviderId | undefined)[] = [];
  async listModels(provider?: ProviderId): Promise<readonly ModelCatalog[]> {
    this.seen.push(provider);
    return [
      {
        provider: "antigravity",
        formats: ["gemini"],
        source: "live",
        models: [
          { address: { provider: "antigravity", model: "g" }, displayName: "G", contextWindow: 80000, maxOutputTokens: 65536 },
          { address: { provider: "antigravity", model: "c" }, displayName: "C" },
        ],
      },
      { provider: "claude", formats: ["anthropic-messages"], source: "static", models: [] },
      { provider: "claude", formats: ["anthropic-messages"], source: "cache", models: [] },
    ];
  }
}
class Access extends AccessPort {
  calls = 0;
  async token() {
    this.calls += 1;
    return "TOKEN";
  }
  async authorize() {
    return false;
  }
}
class Health extends HealthPort {
  constructor(public providers: ProviderId[] = ["claude", "antigravity"]) {
    super();
  }
  enabledProviders() {
    return this.providers;
  }
}
class Status extends DaemonStatusPort {
  next: DaemonStatus = { running: true, url: "http://127.0.0.1:4141", providers: ["claude"] };
  async status() {
    return this.next;
  }
}
class FakeServer extends Server {
  events: string[] = [];
  async start(): Promise<Listening> {
    this.events.push("start");
    return { host: "127.0.0.1", port: 4141 };
  }
  async stop(graceMs: number) {
    this.events.push(`stop ${graceMs}`);
  }
}
class FakeSignal extends ShutdownSignal {
  async wait() {
    return "SIGTERM";
  }
}

function cli(accounts: AccountSummary[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const ports = { login: new Login(), accounts: new Accounts(accounts), usage: new Usage(), models: new Models(), access: new Access(), health: new Health(), status: new Status() };
  const daemon = { server: new FakeServer(), shutdown: new FakeSignal() };
  const driver = new CliDriver(ports, daemon, (t) => out.push(t), (t) => err.push(t));
  return { driver, ports, daemon, out, err, run: (...argv: string[]) => driver.run(argv) };
}

describe("CliDriver", () => {
  test("is a Driver; help and no command print usage", async () => {
    const c = cli();
    expect(c.driver).toBeInstanceOf(Driver);
    expect(await c.run()).toBe(0);
    expect(await c.run("help")).toBe(0);
    expect(c.out).toEqual([`${USAGE}\n`, `${USAGE}\n`]);
  });

  test("login: browser or device code by default with the default timeout; --manual, --new, --key, --from-opencode and --timeout-seconds", async () => {
    const c = cli();
    const none = { key: false, importFrom: undefined };
    expect(await c.run("login", "antigravity")).toBe(0);
    expect(await c.run("login", "claude", "--manual", "--timeout-seconds", "60")).toBe(0);
    expect(await c.run("login", "openai", "--new")).toBe(0);
    expect(await c.run("login", "opencode")).toBe(0);
    expect(await c.run("login", "openrouter", "--key")).toBe(0);
    expect(await c.run("login", "opencode-go", "--from-opencode")).toBe(0);
    expect(c.ports.login.calls).toEqual([
      ["antigravity", { manual: false, fresh: false, ...none, timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
      ["claude", { manual: true, fresh: false, ...none, timeoutMs: 60_000 }],
      ["openai", { manual: false, fresh: true, ...none, timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
      ["opencode", { manual: false, fresh: false, ...none, timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
      ["openrouter", { manual: false, fresh: false, key: true, importFrom: undefined, timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
      ["opencode-go", { manual: false, fresh: false, key: false, importFrom: "opencode", timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
    ]);
    expect(c.out.slice(0, 8)).toEqual([
      "Opening your browser. If it does not open, visit:\nhttps://auth.example/\n",
      "signed in to antigravity as Me (active account)\n",
      "Open:\nhttps://auth.example/\n",
      "signed in to claude as Me (active account)\n",
      "Opening your browser. If it does not open, visit:\nhttps://auth.example/\n",
      "signed in to openai as Me (active account)\n",
      "Confirm this code on the page: ABCD-EFGH\n",
      "Opening your browser. If it does not open, visit:\nhttps://auth.example/\n",
    ]);
  });

  test.each([
    [["login"], "missing or extra arguments"],
    [["login", "nope"], "unknown provider nope"],
    [["login", "antigravity", "--timeout-seconds", "0"], "--timeout-seconds needs a positive integer"],
    [["login", "antigravity", "--timeout-seconds"], "--timeout-seconds needs a positive integer"],
    [["login", "antigravity", "--bogus"], "unknown login option --bogus"],
    [["login", "openrouter", "--key", "--from-opencode"], "--key and --from-opencode exclude each other"],
    [["account"], "account list <provider> | account use <provider> <account-id>"],
    [["account", "list", "antigravity", "extra"], "account list <provider> | account use"],
    [["account", "use", "antigravity"], "account list <provider> | account use"],
    [["account", "use", "antigravity", "a", "b"], "account list <provider> | account use"],
    [["quota"], "missing or extra arguments"],
    [["quota", "antigravity", "x"], "missing or extra arguments"],
    [["models", "a", "b"], "models takes at most one provider"],
    [["serve", "x"], "serve takes no arguments"],
    [["token", "x"], "token takes no arguments"],
    [["status", "x"], "status takes no arguments"],
    [["frobnicate"], "unknown command frobnicate"],
  ])("usage error %p → exit 2", async (argv, message) => {
    const c = cli();
    expect(await c.run(...argv)).toBe(2);
    expect(c.err[0]!.startsWith(message)).toBe(true);
    expect(c.err[0]).toContain(USAGE);
  });

  test("account list (empty, marked active, label shown when it differs) and account use", async () => {
    const empty = cli();
    expect(await empty.run("account", "list", "antigravity")).toBe(0);
    expect(empty.out).toEqual(["no antigravity accounts; run: inference-router login antigravity\n"]);
    const c = cli([
      { provider: "antigravity", id: "a@x", label: "a@x", active: true },
      { provider: "antigravity", id: "b", label: "Bee", active: false },
      { provider: "antigravity", id: "c", label: "c", active: false, needsLogin: "grant rejected" },
    ]);
    expect(await c.run("account", "list", "antigravity")).toBe(0);
    expect(await c.run("account", "use", "antigravity", "b")).toBe(0);
    expect(c.out).toEqual(["* a@x\n", "  b  (Bee)\n", "  c  [needs login: grant rejected]\n", "active antigravity account: b\n"]);
  });

  test("quota and models (all or one provider; limits only when known)", async () => {
    const c = cli();
    expect(await c.run("quota", "antigravity")).toBe(0);
    expect(await c.run("models")).toBe(0);
    expect(await c.run("models", "antigravity")).toBe(0);
    expect(c.ports.models.seen).toEqual([undefined, "antigravity"]);
    expect(c.out.slice(0, 6)).toEqual([
      "Antigravity usage:\n",
      "# antigravity: 2 models (live catalog)\n",
      "antigravity/g  G  context 80000 / output 65536\n",
      "antigravity/c  C\n",
      "# claude: 0 models (built-in list: the live catalog was unavailable)\n",
      "# claude: 0 models (stored copy of the live catalog)\n",
    ]);
  });

  test("serve: token first, listen, wait for the shutdown signal, stop with the grace period", async () => {
    const c = cli();
    expect(await c.run("serve")).toBe(0);
    expect(c.ports.access.calls).toBe(1);
    expect(c.daemon.server.events).toEqual(["start", `stop ${SHUTDOWN_GRACE_MS}`]);
    expect(c.out).toEqual([
      "inference-router listening on http://127.0.0.1:4141 (providers: claude, antigravity)\n",
      "clients authenticate with the router token: inference-router token\n",
      "SIGTERM: stopping (in-flight responses get 10 s)\n",
      "stopped\n",
    ]);
    c.ports.health.providers = [];
    await c.run("serve");
    expect(c.out[4]).toBe("inference-router listening on http://127.0.0.1:4141 (providers: none)\n");
  });

  test("token prints the router token; status reports running (exit 0) or not (exit 1)", async () => {
    const c = cli();
    expect(await c.run("token")).toBe(0);
    expect(await c.run("status")).toBe(0);
    c.ports.status.next = { running: true, url: "http://127.0.0.1:4141", providers: [] };
    expect(await c.run("status")).toBe(0);
    c.ports.status.next = { running: false, url: "http://127.0.0.1:4141", reason: "connection refused" };
    expect(await c.run("status")).toBe(1);
    expect(c.out).toEqual([
      "TOKEN\n",
      "running at http://127.0.0.1:4141 (providers: claude)\n",
      "running at http://127.0.0.1:4141 (providers: none)\n",
      "not running at http://127.0.0.1:4141 (connection refused)\n",
    ]);
  });

  test("a failing command → exit 1 with the error's message", async () => {
    const c = cli();
    c.ports.login.login = () => Promise.reject(new ProviderAuthRequiredError("antigravity", "authorization state mismatch"));
    expect(await c.run("login", "antigravity")).toBe(1);
    expect(c.err).toEqual(["error: antigravity: authorization state mismatch; run `inference-router login antigravity`\n"]);
    c.ports.usage.usage = () => Promise.reject(new TypeError("plain"));
    expect(await c.run("quota", "antigravity")).toBe(1);
    expect(c.err[1]).toBe("error: plain\n");
    c.ports.accounts.list = () => Promise.reject(new Error("disk"));
    expect(await c.run("account", "list", "antigravity")).toBe(1);
    expect(c.err[2]).toBe("error: disk\n");
  });
});
