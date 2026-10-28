import { describe, expect, test } from "bun:test";
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import { describeCatalog, type DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelCatalog, ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { OpencodeConfigPort, type OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import { AccountAdminPort, LoginPort, UsagePort, type AccountSummary, type LoginOptions } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import { DaemonConsolePort, DaemonStatusPort, type DaemonStatus } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import { HealthPort, DescribeModelsPort, RequestModelRefreshPort, type RefreshOutcome } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { PROGRAM } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import { SHUTDOWN_GRACE_MS } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/daemon-commands.ts";
import { DEFAULT_LOGIN_TIMEOUT_S } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/login-command.ts";
import { PROXY_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/proxy-commands.ts";
import { renderHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";
import { proxyCommands } from "@accounts-proxy/proxy/composition/container.ts";
import { Driver } from "@accounts-proxy/proxy/adapters/inbound/driver.ts";
import { Server, ShutdownSignal, type Listening } from "@accounts-proxy/proxy/adapters/inbound/server.ts";

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
  constructor(private accounts: AccountSummary[]) {
    super();
  }
  async list() {
    return this.accounts;
  }
  async use(provider: ProviderId, id: string) {
    return { provider, id, label: id, active: true };
  }
  async remove(_provider: ProviderId, id: string) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    return this.accounts;
  }
}
class Usage extends UsagePort {
  async usage() {
    return { capturedAt: 1, text: "Antigravity usage:" };
  }
}
class Models extends DescribeModelsPort {
  seen: (ProviderId | undefined)[] = [];
  async describeModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]> {
    this.seen.push(provider);
    const catalogs: ModelCatalog[] = [
      {
        provider: "antigravity",
        formats: ["gemini"],
        source: "live",
        models: [
          { address: { provider: "antigravity", model: "g" }, displayName: "G", contextWindow: 80000, maxOutputTokens: 65536 },
          { address: { provider: "antigravity", model: "c" }, displayName: "C" },
          { address: { provider: "antigravity", model: "w" }, displayName: "W", contextWindow: 272000 },
          { address: { provider: "antigravity", model: "o" }, displayName: "O", maxOutputTokens: 4096 },
        ],
      },
      { provider: "claude", formats: ["anthropic-messages"], source: "static", models: [] },
      { provider: "claude", formats: ["anthropic-messages"], source: "cache", models: [] },
      { provider: "openai", formats: ["openai-responses"], source: "unavailable", models: [], error: { code: "provider_auth_required", message: "openai: no active account" } },
    ];
    return catalogs.map((c) => describeCatalog(c, undefined, undefined));
  }
}
class Refresh extends RequestModelRefreshPort {
  seen: (ProviderId | undefined)[] = [];
  by: RefreshOutcome["by"] = "daemon";
  async request(provider?: ProviderId): Promise<RefreshOutcome> {
    this.seen.push(provider);
    return { by: this.by, url: "http://127.0.0.1:4141", catalogs: [describeCatalog({ provider: "claude", formats: ["anthropic-messages"], source: "live", models: [{ address: { provider: "claude", model: "n" }, displayName: "New" }] }, undefined, undefined)] };
  }
}
class OpencodeConfig extends OpencodeConfigPort {
  config(catalogs: readonly DetailedCatalog[], at: OpencodeOrigin) {
    return { providers: catalogs.length, origin: at.origin };
  }
  manifest() {
    return {};
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
class FakeConsole extends DaemonConsolePort {
  attached = 0;
  attach() {
    this.attached += 1;
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
  const ports = { login: new Login(), accounts: new Accounts(accounts), usage: new Usage(), models: new Models(), refresh: new Refresh(), opencode: new OpencodeConfig(), origin: { origin: "http://127.0.0.1:4141", tokenCommand: ["ir", "token"] }, access: new Access(), health: new Health(), status: new Status() };
  const daemon = { server: new FakeServer(), shutdown: new FakeSignal(), console: new FakeConsole() };
  const driver = new CommandLineDriver(proxyCommands(ports, daemon), PROGRAM, (t) => out.push(t), (t) => err.push(t));
  return { driver, ports, daemon, out, err, run: (...argv: string[]) => driver.run(argv) };
}

const OVERVIEW = renderHelp(PROXY_HELP, [], PROGRAM);

describe("the proxy's commands", () => {
  test("is a Driver; no command, help, --help and -h print the overview on stdout with exit 0", async () => {
    const c = cli();
    expect(c.driver).toBeInstanceOf(Driver);
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) expect(await c.run(...argv)).toBe(0);
    expect(c.out).toEqual([OVERVIEW, OVERVIEW, OVERVIEW, OVERVIEW]);
    expect(c.err).toEqual([]);
    expect(OVERVIEW.startsWith("bun run proxy — one local endpoint")).toBe(true);
  });

  test.each([
    [["help", "login"], "login"],
    [["login", "--help"], "login"],
    [["login", "claude", "-h"], "login"],
    [["help", "account"], "account"],
    [["account", "--help"], "account"],
    [["help", "account", "list"], "account list"],
    [["account", "list", "--help"], "account list"],
    [["account", "use", "-h"], "account use"],
    [["account", "remove", "--help"], "account remove"],
    [["help", "quota"], "quota"],
    [["models", "-h"], "models"],
    [["opencode-config", "--help"], "opencode-config"],
    [["serve", "--help"], "serve"],
    [["token", "--help"], "token"],
    [["status", "--help"], "status"],
    [["help", "help"], "help"],
  ])("%p prints the help of `%s` and runs nothing", async (argv, path) => {
    const c = cli();
    expect(await c.run(...argv)).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out).toHaveLength(1);
    expect(c.out[0]!.startsWith(`bun run proxy ${path} — `)).toBe(true);
    for (const section of ["usage:", "options:", "exit codes:", "examples:"]) expect(c.out[0]).toContain(`\n${section}\n`);
    expect(c.ports.login.calls).toEqual([]);
    expect(c.daemon.server.events).toEqual([]);
    expect(c.ports.access.calls).toBe(0);
  });

  test("every command's help has a description, its exit codes and at least two examples run as printed", () => {
    const all = [PROXY_HELP, ...PROXY_HELP.subcommands!, ...PROXY_HELP.subcommands!.flatMap((sub) => sub.subcommands ?? [])];
    expect(all.map((help) => help.name)).toEqual(["", "login", "account", "quota", "models", "opencode-config", "serve", "token", "status", "help", "list", "use", "remove"]);
    for (const help of all) {
      expect(help.description.length).toBeGreaterThan(0);
      expect(help.exits.map((exit) => exit.name)).toContain("2");
      expect(help.examples.length).toBeGreaterThanOrEqual(2);
      for (const example of help.examples) expect(example.name.startsWith(`${PROGRAM} `) || example.name.startsWith("export ") || example.name.startsWith("ACCOUNTS_PROXY_HOME=")).toBe(true);
    }
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
    [["login"], "login needs a provider", "login"],
    [["login", "nope"], "unknown provider nope", "login"],
    [["login", "antigravity", "--timeout-seconds", "0"], "--timeout-seconds needs a positive integer", "login"],
    [["login", "antigravity", "--timeout-seconds"], "--timeout-seconds needs a positive integer", "login"],
    [["login", "antigravity", "--bogus"], "unknown login option --bogus", "login"],
    [["login", "openrouter", "--key", "--from-opencode"], "--key and --from-opencode exclude each other", "login"],
    [["account"], "missing account subcommand: one of list, use, remove", "account"],
    [["account", "lst", "antigravity"], "unknown account subcommand lst (did you mean list?)", "account"],
    [["account", "bogus", "--help"], "unknown account subcommand bogus", "account"],
    [["account", "list"], "account list needs a provider", "account list"],
    [["account", "list", "antigravity", "extra"], "account list takes one provider", "account list"],
    [["account", "use", "antigravity"], "account use needs a provider and one account id", "account use"],
    [["account", "use", "antigravity", "a", "b"], "account use needs a provider and one account id", "account use"],
    [["account", "remove", "antigravity"], "account remove needs a provider and one account id", "account remove"],
    [["account", "remove"], "account remove needs a provider", "account remove"],
    [["quota"], "quota needs a provider", "quota"],
    [["quota", "antigravity", "x"], "quota takes one provider", "quota"],
    [["models", "a", "b"], "models takes at most one provider, --json and --refresh", "models"],
    [["models", "--json", "--json"], "models takes at most one provider, --json and --refresh", "models"],
    [["models", "--refresh", "--refresh"], "models takes at most one provider, --json and --refresh", "models"],
    [["models", "nope"], "unknown provider nope", "models"],
    [["opencode-config", "x"], "opencode-config takes no arguments", "opencode-config"],
    [["serve", "x"], "serve takes no arguments", "serve"],
    [["token", "x"], "token takes no arguments", "token"],
    [["status", "x"], "status takes no arguments", "status"],
    [["help", "frobnicate"], "unknown command frobnicate", "help"],
    [["help", "account", "lst"], "unknown account subcommand lst (did you mean list?)", "help"],
    [["help", "login", "x"], "login has no subcommands", "help"],
    [["frobnicate"], "unknown command frobnicate", ""],
    [["logn"], "unknown command logn (did you mean login?)", ""],
  ])("usage error %p → exit 2: %s", async (argv, message, path) => {
    const c = cli();
    expect(await c.run(...argv)).toBe(2);
    expect(c.out).toEqual([]);
    const [first, ...rest] = c.err[0]!.split("\n");
    expect(first).toBe(message);
    expect(rest.at(-2)).toBe(`for options, exit codes and examples: ${["bun run proxy", "help", ...(path === "" ? [] : path.split(" "))].join(" ")}`);
  });

  test("account list (empty, marked active, label shown when it differs) and account use", async () => {
    const empty = cli();
    expect(await empty.run("account", "list", "antigravity")).toBe(0);
    expect(empty.out).toEqual(["no antigravity accounts; run: bun run proxy login antigravity\n"]);
    const c = cli([
      { provider: "antigravity", id: "a@x", label: "a@x", active: true },
      { provider: "antigravity", id: "b", label: "Bee", active: false },
      { provider: "antigravity", id: "c", label: "c", active: false, needsLogin: "grant rejected" },
    ]);
    expect(await c.run("account", "list", "antigravity")).toBe(0);
    expect(await c.run("account", "use", "antigravity", "b")).toBe(0);
    expect(c.out).toEqual(["* a@x\n", "  b  (Bee)\n", "  c  [needs login: grant rejected]\n", "active antigravity account: b\n"]);
  });

  test("account remove: the active one (another left, or none left) and an inactive one", async () => {
    const two = () => [
      { provider: "antigravity" as const, id: "a", label: "a", active: true },
      { provider: "antigravity" as const, id: "b", label: "b", active: false },
    ];
    const c = cli(two());
    expect(await c.run("account", "remove", "antigravity", "b")).toBe(0);
    expect(await c.run("account", "remove", "antigravity", "a")).toBe(0);
    expect(c.out).toEqual(["removed antigravity account: b\n", "removed antigravity account: a\n", "no antigravity accounts left; run: bun run proxy login antigravity\n"]);
    const d = cli(two());
    expect(await d.run("account", "remove", "antigravity", "a")).toBe(0);
    expect(d.out).toEqual(["removed antigravity account: a\n", "no active antigravity account; run: bun run proxy account use antigravity <account-id>\n"]);
  });

  test("quota and models (all or one provider; limits only when known)", async () => {
    const c = cli();
    expect(await c.run("quota", "antigravity")).toBe(0);
    expect(await c.run("models")).toBe(0);
    expect(await c.run("models", "antigravity")).toBe(0);
    expect(c.ports.models.seen).toEqual([undefined, "antigravity"]);
    expect(c.out.slice(0, 9)).toEqual([
      "Antigravity usage:\n",
      "# antigravity: 4 models (live catalog)\n",
      "antigravity/g  G  context 80000 / output 65536\n",
      "antigravity/c  C\n",
      "antigravity/w  W  context 272000\n",
      "antigravity/o  O  output 4096\n",
      "# claude: 0 models (built-in list)\n",
      "# claude: 0 models (stored copy of the live catalog)\n",
      "# openai: 0 models (unavailable: openai: no active account)\n",
    ]);
  });

  test("models --json: every detail with its sources; opencode-config: the configuration of every model", async () => {
    const c = cli();
    expect(await c.run("models", "--json", "antigravity")).toBe(0);
    expect(c.ports.models.seen).toEqual(["antigravity"]);
    const listed = JSON.parse(c.out[0]!);
    expect(listed.catalogs[0].models[0]).toEqual({ id: "antigravity/g", provider: "antigravity", model: "g", name: "G", formats: ["gemini"], contextWindow: 80000, maxOutputTokens: 65536, sources: { name: "provider:antigravity", contextWindow: "provider:antigravity", maxOutputTokens: "provider:antigravity" } });
    expect(await c.run("opencode-config")).toBe(0);
    expect(JSON.parse(c.out[1]!)).toEqual({ providers: 4, origin: "http://127.0.0.1:4141" });
  });

  test("models --refresh: the daemon's or this process's refresh, as text or JSON; no description is read", async () => {
    const c = cli();
    expect(await c.run("models", "--refresh")).toBe(0);
    expect(c.out).toEqual(["refreshed by the daemon at http://127.0.0.1:4141\n", "# claude: 1 models (live catalog)\n", "claude/n  New\n"]);
    c.ports.refresh.by = "this process";
    expect(await c.run("models", "claude", "--refresh", "--json")).toBe(0);
    expect(JSON.parse(c.out[3]!)).toMatchObject({ refreshedBy: "this process", url: "http://127.0.0.1:4141", catalogs: [{ provider: "claude" }] });
    expect(await c.run("models", "--refresh")).toBe(0);
    expect(c.out[4]).toBe("no daemon at http://127.0.0.1:4141: refreshed by this process (the stored copies a daemon reads when it starts)\n");
    expect([c.ports.refresh.seen, c.ports.models.seen]).toEqual([[undefined, "claude", undefined], []]);
  });

  test("serve: token first, listen, print the logs from then on (C1), wait for the shutdown signal, stop with the grace period", async () => {
    const c = cli();
    expect(await c.run("serve", "--help")).toBe(0);
    expect(c.daemon.console.attached).toBe(0);
    c.out.length = 0;
    expect(await c.run("serve")).toBe(0);
    expect(c.daemon.console.attached).toBe(1);
    expect(c.ports.access.calls).toBe(1);
    expect(c.daemon.server.events).toEqual(["start", `stop ${SHUTDOWN_GRACE_MS}`]);
    expect(c.out).toEqual([
      "accounts-proxy listening on http://127.0.0.1:4141 (providers: claude, antigravity)\n",
      "clients authenticate with the proxy token: bun run proxy token\n",
      "SIGTERM: stopping (in-flight responses get 10 s)\n",
      "stopped\n",
    ]);
    c.ports.health.providers = [];
    await c.run("serve");
    expect(c.out[4]).toBe("accounts-proxy listening on http://127.0.0.1:4141 (providers: none)\n");
  });

  test("token prints the proxy token; status reports running (exit 0) or not (exit 1)", async () => {
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
    expect(c.err).toEqual(["error: antigravity: authorization state mismatch; run `accounts-proxy login antigravity`\n"]);
    c.ports.usage.usage = () => Promise.reject(new TypeError("plain"));
    expect(await c.run("quota", "antigravity")).toBe(1);
    expect(c.err[1]).toBe("error: plain\n");
    c.ports.accounts.list = () => Promise.reject(new Error("disk"));
    expect(await c.run("account", "list", "antigravity")).toBe(1);
    expect(c.err[2]).toBe("error: disk\n");
  });
});
