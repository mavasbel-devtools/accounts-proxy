// The proxy's command line: the ports its commands drive, the program overview and the help of `help`. The command
// tree itself is wired in the composition root.
import { PROVIDER_IDS } from "@accounts-proxy/core/domain/models.ts";
import type { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import type { AccountAdminPort, LoginPort, UsagePort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { DaemonStatusPort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import type { OpencodeConfigPort, OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import type { DescribeModelsPort, HealthPort, RequestModelRefreshPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { CommandHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { ACCOUNT_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/account-command.ts";
import { FAILED_EXIT, HOME_VARIABLE, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import { MODELS_HELP, OPENCODE_CONFIG_HELP, QUOTA_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/catalog-commands.ts";
import { SERVE_HELP, STATUS_HELP, TOKEN_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/daemon-commands.ts";
import { LOGIN_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/login-command.ts";
import { helpCommandHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-command.ts";

export type CliPorts = {
  readonly login: LoginPort;
  readonly accounts: AccountAdminPort;
  readonly usage: UsagePort;
  readonly models: DescribeModelsPort;
  readonly refresh: RequestModelRefreshPort;
  readonly opencode: OpencodeConfigPort;
  readonly origin: OpencodeOrigin;
  readonly access: AccessPort;
  readonly health: HealthPort;
  readonly status: DaemonStatusPort;
};

export const HELP_HELP = helpCommandHelp([
  { name: "bun run proxy help login", text: "everything about `login`" },
  { name: "bun run proxy account use --help", text: "the help of a subcommand" },
], [
  { name: "<command>", text: "the command to describe" },
  { name: "<subcommand>", text: "one of its subcommands, for a command that has them (account)" },
]);

export const PROXY_HELP: CommandHelp = {
  name: "",
  synopsis: ["<command> [<arguments>]", "help [<command> [<subcommand>]]"],
  summary: "one local endpoint for subscription and API-key inference accounts",
  description: [
    "A daemon on 127.0.0.1 that serves the Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini formats and routes each request to a provider account the proxy signed in to. Run it from the repository root as `bun run proxy <command>`; the workspace also declares the `accounts-proxy` bin.",
    `providers: ${PROVIDER_IDS.join(", ")}`,
  ],
  exits: [{ name: "0", text: "success; also every help" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy login claude", text: "sign in to Claude" },
    { name: "bun run proxy serve", text: "run the daemon on 127.0.0.1:4141" },
    { name: "bun run proxy token", text: "the key clients send" },
    { name: "bun run proxy help login", text: "the options, exit codes and examples of one command" },
  ],
  subcommands: [LOGIN_HELP, ACCOUNT_HELP, QUOTA_HELP, MODELS_HELP, OPENCODE_CONFIG_HELP, SERVE_HELP, TOKEN_HELP, STATUS_HELP, HELP_HELP],
};
