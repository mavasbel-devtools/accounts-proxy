// Command-line inbound adapter: parses argv, drives the inbound ports, renders results. Exit codes: 0 success,
// 1 the command failed (message on stderr), 2 usage error.
import { RouterError } from "@inference-router/core/domain/errors.ts";
import { isProviderId, type ProviderId } from "@inference-router/core/domain/models.ts";
import type { AccountAdminPort, LoginPort, UsagePort } from "@inference-router/core/ports/inbound/accounts.ts";
import type { ListModelsPort } from "@inference-router/core/ports/inbound/routing.ts";
import { Driver } from "../driver.ts";

export type Writer = (text: string) => void;
export type CliPorts = { readonly login: LoginPort; readonly accounts: AccountAdminPort; readonly usage: UsagePort; readonly models: ListModelsPort };

export const DEFAULT_LOGIN_TIMEOUT_S = 300;

export const USAGE = `usage: inference-router <command>
  login <provider> [--manual] [--timeout-seconds N]   browser sign-in (default timeout ${DEFAULT_LOGIN_TIMEOUT_S} s)
  account list <provider>                             accounts stored by the router
  account use <provider> <account-id>                 choose the active account
  quota <provider>                                    remaining provider quota
  models [<provider>]                                 live model catalog
  help
providers: claude-subscription, antigravity`;

class UsageError extends Error {}

export class CliDriver extends Driver {
  constructor(
    private readonly ports: CliPorts,
    private readonly out: Writer,
    private readonly err: Writer,
  ) {
    super();
  }

  async run(argv: readonly string[]): Promise<number> {
    try {
      await this.dispatch([...argv]);
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        this.err(`${error.message}\n${USAGE}\n`);
        return 2;
      }
      const message = error instanceof RouterError || error instanceof Error ? error.message : String(error);
      this.err(`error: ${message}\n`);
      return 1;
    }
  }

  private async dispatch(args: string[]): Promise<void> {
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
        if (rest.length > 1) throw new UsageError("models takes at most one provider");
        const models = await this.ports.models.listModels(rest[0] === undefined ? undefined : provider(rest[0], true));
        for (const m of models) {
          const limits = m.contextWindow !== undefined ? `  context ${m.contextWindow} / output ${m.maxOutputTokens}` : "";
          this.out(`${m.address.provider}/${m.address.model}  ${m.displayName}${limits}\n`);
        }
        return;
      }
      case "help":
      case undefined:
        this.out(`${USAGE}\n`);
        return;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  }

  private async login(args: string[]): Promise<void> {
    const id = provider(args.shift(), true);
    let manual = false;
    let timeoutS = DEFAULT_LOGIN_TIMEOUT_S;
    while (args.length > 0) {
      const flag = args.shift();
      if (flag === "--manual") manual = true;
      else if (flag === "--timeout-seconds") {
        const value = Number(args.shift());
        if (!Number.isInteger(value) || value < 1) throw new UsageError("--timeout-seconds needs a positive integer");
        timeoutS = value;
      } else throw new UsageError(`unknown login option ${flag}`);
    }
    const account = await this.ports.login.login(id, {
      manual,
      timeoutMs: timeoutS * 1000,
      onAuthorizeUrl: (url) => this.out(`${manual ? "Open" : "Opening your browser. If it does not open, visit"}:\n${url}\n`),
    });
    this.out(`signed in to ${account.provider} as ${account.label} (active account)\n`);
  }

  private async account(args: string[]): Promise<void> {
    const [sub, id, accountId, ...extra] = args;
    if (sub === "list" && accountId === undefined) {
      const accounts = await this.ports.accounts.list(provider(id, true));
      if (accounts.length === 0) this.out(`no ${id} accounts; run: inference-router login ${id}\n`);
      for (const a of accounts) this.out(`${a.active ? "*" : " "} ${a.id}${a.label !== a.id ? `  (${a.label})` : ""}\n`);
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
