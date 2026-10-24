// `account list <provider>` and `account use <provider> <account-id>`: the proxy's own stored accounts.
import type { AccountAdminPort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import { CliCommand, CommandGroup, type CommandHelp, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { FAILED_EXIT, HOME_VARIABLE, PROGRAM, providerArgument, PROVIDER_ARGUMENT, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";

export const ACCOUNT_LIST_HELP: CommandHelp = {
  name: "list",
  synopsis: ["account list <provider>"],
  summary: "the accounts stored for a provider",
  description: [
    "One line per account: `*` marks the active one, the label follows in parentheses when it differs from the id, and `[needs login: <reason>]` marks one whose refresh was rejected. With no account, the login command to run.",
  ],
  arguments: [PROVIDER_ARGUMENT],
  exits: [{ name: "0", text: "the accounts were listed (also when there is none)" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy account list openai", text: "the stored ChatGPT accounts and which one is active" },
    { name: "bun run proxy account list antigravity", text: "the stored Google accounts" },
  ],
};

export const ACCOUNT_USE_HELP: CommandHelp = {
  name: "use",
  synopsis: ["account use <provider> <account-id>"],
  summary: "choose the active account",
  description: [
    "Requests to the provider use the active account. The proxy never switches accounts by itself, also not on a quota error. The id is the one `account list` prints.",
  ],
  arguments: [PROVIDER_ARGUMENT, { name: "<account-id>", text: "an id from `account list <provider>`" }],
  exits: [{ name: "0", text: "the account is the active one" }, { name: "1", text: "no stored account has that id, or the store failed: `error: <message>` on stderr" }, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy account use antigravity me@example.com", text: "make the listed account me@example.com the active one" },
    { name: "bun run proxy account list openai && bun run proxy account use openai <id>", text: "list the ids, then pick one" },
  ],
};

export const ACCOUNT_HELP: CommandHelp = {
  name: "account",
  synopsis: ["account <list | use> ..."],
  summary: "list the stored accounts or choose the active one",
  description: ["The accounts the proxy signed in to (`login`), per provider. They live only in the proxy's data directory."],
  exits: [{ name: "0", text: "the subcommand succeeded" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [...ACCOUNT_LIST_HELP.examples.slice(0, 1), ...ACCOUNT_USE_HELP.examples.slice(0, 1)],
  subcommands: [ACCOUNT_LIST_HELP, ACCOUNT_USE_HELP],
};

export class AccountListCommand extends CliCommand {
  readonly help = ACCOUNT_LIST_HELP;

  constructor(private readonly accounts: AccountAdminPort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const provider = providerArgument(args[0], "account list");
    if (args.length > 1) throw new UsageError("account list takes one provider");
    const accounts = await this.accounts.list(provider);
    if (accounts.length === 0) out(`no ${provider} accounts; run: ${PROGRAM} login ${provider}\n`);
    for (const a of accounts) {
      const relogin = a.needsLogin !== undefined ? `  [needs login: ${a.needsLogin}]` : "";
      out(`${a.active ? "*" : " "} ${a.id}${a.label !== a.id ? `  (${a.label})` : ""}${relogin}\n`);
    }
  }
}

export class AccountUseCommand extends CliCommand {
  readonly help = ACCOUNT_USE_HELP;

  constructor(private readonly accounts: AccountAdminPort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const provider = providerArgument(args[0], "account use");
    if (args.length !== 2) throw new UsageError("account use needs a provider and one account id");
    const chosen = await this.accounts.use(provider, args[1]!);
    out(`active ${chosen.provider} account: ${chosen.id}\n`);
  }
}

export class AccountCommand extends CommandGroup {
  readonly help = ACCOUNT_HELP;

  constructor(protected readonly subcommands: readonly CliCommand[]) {
    super();
  }
}
