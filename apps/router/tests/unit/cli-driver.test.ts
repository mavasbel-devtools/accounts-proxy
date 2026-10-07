import { describe, expect, test } from "bun:test";
import { ProviderAuthRequiredError } from "../../../../packages/core/src/domain/errors.ts";
import type { ModelInfo, ProviderId } from "../../../../packages/core/src/domain/models.ts";
import { AccountAdminPort, LoginPort, UsagePort, type AccountSummary, type LoginOptions } from "../../../../packages/core/src/ports/inbound/accounts.ts";
import { ListModelsPort } from "../../../../packages/core/src/ports/inbound/routing.ts";
import { CliDriver, DEFAULT_LOGIN_TIMEOUT_S, USAGE } from "../../src/adapters/inbound/cli/cli-driver.ts";
import { Driver } from "../../src/adapters/inbound/driver.ts";

class Login extends LoginPort {
  calls: [ProviderId, Omit<LoginOptions, "onAuthorizeUrl">][] = [];
  async login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary> {
    this.calls.push([provider, { manual: options.manual, timeoutMs: options.timeoutMs }]);
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
  async listModels(provider?: ProviderId): Promise<readonly ModelInfo[]> {
    this.seen.push(provider);
    return [
      { address: { provider: "antigravity", model: "g" }, displayName: "G", contextWindow: 80000, maxOutputTokens: 65536 },
      { address: { provider: "antigravity", model: "c" }, displayName: "C" },
    ];
  }
}

function cli(accounts: AccountSummary[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const ports = { login: new Login(), accounts: new Accounts(accounts), usage: new Usage(), models: new Models() };
  const driver = new CliDriver(ports, (t) => out.push(t), (t) => err.push(t));
  return { driver, ports, out, err, run: (...argv: string[]) => driver.run(argv) };
}

describe("CliDriver", () => {
  test("is a Driver; help and no command print usage", async () => {
    const c = cli();
    expect(c.driver).toBeInstanceOf(Driver);
    expect(await c.run()).toBe(0);
    expect(await c.run("help")).toBe(0);
    expect(c.out).toEqual([`${USAGE}\n`, `${USAGE}\n`]);
  });

  test("login: browser by default with the default timeout; --manual and --timeout-seconds", async () => {
    const c = cli();
    expect(await c.run("login", "antigravity")).toBe(0);
    expect(await c.run("login", "claude-subscription", "--manual", "--timeout-seconds", "60")).toBe(0);
    expect(c.ports.login.calls).toEqual([
      ["antigravity", { manual: false, timeoutMs: DEFAULT_LOGIN_TIMEOUT_S * 1000 }],
      ["claude-subscription", { manual: true, timeoutMs: 60_000 }],
    ]);
    expect(c.out).toEqual([
      "Opening your browser. If it does not open, visit:\nhttps://auth.example/\n",
      "signed in to antigravity as Me (active account)\n",
      "Open:\nhttps://auth.example/\n",
      "signed in to claude-subscription as Me (active account)\n",
    ]);
  });

  test.each([
    [["login"], "missing or extra arguments"],
    [["login", "nope"], "unknown provider nope"],
    [["login", "antigravity", "--timeout-seconds", "0"], "--timeout-seconds needs a positive integer"],
    [["login", "antigravity", "--timeout-seconds"], "--timeout-seconds needs a positive integer"],
    [["login", "antigravity", "--bogus"], "unknown login option --bogus"],
    [["account"], "account list <provider> | account use <provider> <account-id>"],
    [["account", "list", "antigravity", "extra"], "account list <provider> | account use"],
    [["account", "use", "antigravity"], "account list <provider> | account use"],
    [["account", "use", "antigravity", "a", "b"], "account list <provider> | account use"],
    [["quota"], "missing or extra arguments"],
    [["quota", "antigravity", "x"], "missing or extra arguments"],
    [["models", "a", "b"], "models takes at most one provider"],
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
    ]);
    expect(await c.run("account", "list", "antigravity")).toBe(0);
    expect(await c.run("account", "use", "antigravity", "b")).toBe(0);
    expect(c.out).toEqual(["* a@x\n", "  b  (Bee)\n", "active antigravity account: b\n"]);
  });

  test("quota and models (all or one provider; limits only when known)", async () => {
    const c = cli();
    expect(await c.run("quota", "antigravity")).toBe(0);
    expect(await c.run("models")).toBe(0);
    expect(await c.run("models", "antigravity")).toBe(0);
    expect(c.ports.models.seen).toEqual([undefined, "antigravity"]);
    expect(c.out.slice(0, 3)).toEqual(["Antigravity usage:\n", "antigravity/g  G  context 80000 / output 65536\n", "antigravity/c  C\n"]);
  });

  test("a failing command → exit 1 with the message; non-Error throwables too", async () => {
    const c = cli();
    c.ports.login.login = () => Promise.reject(new ProviderAuthRequiredError("antigravity", "authorization state mismatch"));
    expect(await c.run("login", "antigravity")).toBe(1);
    expect(c.err).toEqual(["error: antigravity: authorization state mismatch; run `inference-router login antigravity`\n"]);
    c.ports.usage.usage = () => Promise.reject("plain");
    expect(await c.run("quota", "antigravity")).toBe(1);
    expect(c.err[1]).toBe("error: plain\n");
    c.ports.accounts.list = () => Promise.reject(new Error("disk"));
    expect(await c.run("account", "list", "antigravity")).toBe(1);
    expect(c.err[2]).toBe("error: disk\n");
  });
});
