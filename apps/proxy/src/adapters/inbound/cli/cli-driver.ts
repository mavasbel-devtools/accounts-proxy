// Command-line inbound adapter: parses argv, drives the inbound ports, renders results. Exit codes: 0 success,
// 1 the command failed (message on stderr), 2 usage error.
import type { KeyImportSource } from "@accounts-proxy/core/domain/api-key.ts";
import { isProviderId, PROVIDER_IDS, type CatalogSource, type ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import type { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import type { AccountAdminPort, LoginPort, UsagePort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { DaemonStatusPort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import type { OpencodeConfigPort, OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import type { DescribeModelsPort, HealthPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { Driver } from "@accounts-proxy/proxy/adapters/inbound/driver.ts";
import type { Server, ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";

export type Writer = (text: string) => void;
export type CliPorts = {
  readonly login: LoginPort;
  readonly accounts: AccountAdminPort;
  readonly usage: UsagePort;
  readonly models: DescribeModelsPort;
  readonly opencode: OpencodeConfigPort;
  readonly origin: OpencodeOrigin;
  readonly access: AccessPort;
  readonly health: HealthPort;
  readonly status: DaemonStatusPort;
};
/** What `serve` runs: the socket server until the process is asked to stop. */
export type CliDaemon = { readonly server: Server; readonly shutdown: ShutdownSignal };

/** In-flight responses get this long to finish after SIGINT/SIGTERM (P4 plan §2.1). */
export const SHUTDOWN_GRACE_MS = 10_000;

export const DEFAULT_LOGIN_TIMEOUT_S = 300;

export const USAGE = `usage: accounts-proxy <command>
  login <provider> [--manual] [--new] [--key] [--from-opencode] [--timeout-seconds N]
                                                      sign in (default timeout ${DEFAULT_LOGIN_TIMEOUT_S} s): browser, or a device
                                                      code for opencode/opencode-go (one shared Console account);
                                                      openai: --new registers another ChatGPT account;
                                                      cheaper-inference: the API key is asked at a hidden prompt;
                                                      --key: enter an API key at a hidden prompt instead;
                                                      --from-opencode: import the API key OpenCode stores
  account list <provider>                             accounts stored by the proxy
  account use <provider> <account-id>                 choose the active account
  quota <provider>                                    remaining provider quota
  models [<provider>] [--json]                        model catalog (and where it came from); --json: every
                                                      detail with its source
  opencode-config                                     the opencode v2 configuration of every model (JSON)
  serve                                               run the daemon in the foreground (Ctrl-C stops it)
  token                                               print the proxy token clients send (created on first use)
  status                                              check whether the daemon answers on the configured port
  help
providers: ${PROVIDER_IDS.join(", ")}`;

class UsageError extends Error {}

const SOURCE_TEXT: Readonly<Record<CatalogSource, string>> = {
  live: "live catalog",
  cache: "stored copy of the live catalog",
  static: "built-in list: the live catalog was unavailable",
  unavailable: "unavailable",
};

export class CliDriver extends Driver {
  constructor(
    private readonly ports: CliPorts,
    private readonly daemon: CliDaemon,
    private readonly out: Writer,
    private readonly err: Writer,
  ) {
    super();
  }

  async run(argv: readonly string[]): Promise<number> {
    try {
      return (await this.dispatch([...argv])) ?? 0;
    } catch (error) {
      if (error instanceof UsageError) {
        this.err(`${error.message}\n${USAGE}\n`);
        return 2;
      }
      const message = errorMessage(error);
      this.err(`error: ${message}\n`);
      return 1;
    }
  }

  private async dispatch(args: string[]): Promise<number | void> {
    const [command, ...rest] = args;
    switch (command) {
      case "login":
        return this.login(rest);
      case "account":
        return this.account(rest);
      case "quota": {
        const report = await this.ports.usage.usage(provider(rest[0], rest.length === 1));
        this.out(`${report.text}\n`);
        return;
      }
      case "models": {
        const json = rest.includes("--json");
        const names = rest.filter((a) => a !== "--json");
        if (names.length > 1 || rest.length - names.length > 1) throw new UsageError("models takes at most one provider and --json");
        const catalogs = await this.ports.models.describeModels(names[0] === undefined ? undefined : provider(names[0], true));
        if (json) {
          this.out(`${JSON.stringify({ catalogs }, null, 2)}\n`);
          return;
        }
        for (const catalog of catalogs) {
          this.out(`# ${catalog.provider}: ${catalog.models.length} models (${SOURCE_TEXT[catalog.source]}${catalog.error !== undefined ? `: ${catalog.error.message}` : ""})\n`);
          for (const m of catalog.models) {
            // Each limit only when a source states it (OpenAI's list names the context window only, live L0).
            const limits = [m.contextWindow !== undefined ? `context ${m.contextWindow}` : "", m.maxOutputTokens !== undefined ? `output ${m.maxOutputTokens}` : ""].filter((x) => x !== "").join(" / ");
            this.out(`${m.id}  ${m.name}${limits === "" ? "" : `  ${limits}`}\n`);
          }
        }
        return;
      }
      case "opencode-config":
        if (rest.length > 0) throw new UsageError("opencode-config takes no arguments");
        this.out(`${JSON.stringify(this.ports.opencode.config(await this.ports.models.describeModels(), this.ports.origin), null, 2)}\n`);
        return;
      case "serve":
        if (rest.length > 0) throw new UsageError("serve takes no arguments");
        return this.serve();
      case "token":
        if (rest.length > 0) throw new UsageError("token takes no arguments");
        this.out(`${await this.ports.access.token()}\n`);
        return;
      case "status": {
        if (rest.length > 0) throw new UsageError("status takes no arguments");
        const status = await this.ports.status.status();
        if (status.running) {
          this.out(`running at ${status.url} (providers: ${status.providers.join(", ") || "none"})\n`);
          return;
        }
        this.out(`not running at ${status.url} (${status.reason})\n`);
        return 1;
      }
      case "help":
      case undefined:
        this.out(`${USAGE}\n`);
        return;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  }

  private async serve(): Promise<void> {
    await this.ports.access.token();
    const listening = await this.daemon.server.start();
    const providers = this.ports.health.enabledProviders();
    this.out(`accounts-proxy listening on http://${listening.host}:${listening.port} (providers: ${providers.join(", ") || "none"})\n`);
    this.out("clients authenticate with the proxy token: accounts-proxy token\n");
    const signal = await this.daemon.shutdown.wait();
    this.out(`${signal}: stopping (in-flight responses get ${SHUTDOWN_GRACE_MS / 1000} s)\n`);
    await this.daemon.server.stop(SHUTDOWN_GRACE_MS);
    this.out("stopped\n");
  }

  private async login(args: string[]): Promise<void> {
    const id = provider(args.shift(), true);
    let manual = false;
    let fresh = false;
    let key = false;
    let importFrom: KeyImportSource | undefined;
    let timeoutS = DEFAULT_LOGIN_TIMEOUT_S;
    while (args.length > 0) {
      const flag = args.shift();
      if (flag === "--manual") manual = true;
      else if (flag === "--new") fresh = true;
      else if (flag === "--key") key = true;
      else if (flag === "--from-opencode") importFrom = "opencode";
      else if (flag === "--timeout-seconds") {
        const value = Number(args.shift());
        if (!Number.isInteger(value) || value < 1) throw new UsageError("--timeout-seconds needs a positive integer");
        timeoutS = value;
      } else throw new UsageError(`unknown login option ${flag}`);
    }
    if (key && importFrom !== undefined) throw new UsageError("--key and --from-opencode exclude each other");
    const account = await this.ports.login.login(id, {
      manual,
      fresh,
      key,
      importFrom,
      timeoutMs: timeoutS * 1000,
      onAuthorizeUrl: (url) => this.out(`${manual ? "Open" : "Opening your browser. If it does not open, visit"}:\n${url}\n`),
      onUserCode: (code) => this.out(`Confirm this code on the page: ${code}\n`),
    });
    this.out(`signed in to ${account.provider} as ${account.label} (active account)\n`);
  }

  private async account(args: string[]): Promise<void> {
    const [sub, id, accountId, ...extra] = args;
    if (sub === "list" && accountId === undefined) {
      const accounts = await this.ports.accounts.list(provider(id, true));
      if (accounts.length === 0) this.out(`no ${id} accounts; run: accounts-proxy login ${id}\n`);
      for (const a of accounts) {
        const relogin = a.needsLogin !== undefined ? `  [needs login: ${a.needsLogin}]` : "";
        this.out(`${a.active ? "*" : " "} ${a.id}${a.label !== a.id ? `  (${a.label})` : ""}${relogin}\n`);
      }
      return;
    }
    if (sub === "use" && accountId !== undefined && extra.length === 0) {
      const chosen = await this.ports.accounts.use(provider(id, true), accountId);
      this.out(`active ${chosen.provider} account: ${chosen.id}\n`);
      return;
    }
    throw new UsageError("account list <provider> | account use <provider> <account-id>");
  }
}

function provider(value: string | undefined, valid: boolean): ProviderId {
  if (!valid || value === undefined) throw new UsageError("missing or extra arguments");
  if (!isProviderId(value)) throw new UsageError(`unknown provider ${value}`);
  return value;
}
