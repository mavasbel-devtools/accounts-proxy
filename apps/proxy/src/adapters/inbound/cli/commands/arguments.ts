// What the proxy's commands share: the provider argument, the exit codes and the variables every command reads.
import { isProviderId, PROVIDER_IDS, type ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { type HelpEntry, UsageError } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";

/** How the help and the messages name the program: the repository's script (the workspace also declares the `accounts-proxy` bin). */
export const PROGRAM = "bun run proxy";

export const PROVIDER_ARGUMENT: HelpEntry = { name: "<provider>", text: `one of ${PROVIDER_IDS.join(", ")}` };

export const FAILED_EXIT: HelpEntry = { name: "1", text: "the command failed: `error: <message>` on stderr" };
export const USAGE_EXIT: HelpEntry = { name: "2", text: "usage error: the message and the command's usage on stderr" };

export const HOME_VARIABLE: HelpEntry = { name: "ACCOUNTS_PROXY_HOME", text: "the data directory (default: .cache/ of the repository the program runs from)" };

/** The provider named by a command's argument. */
export function providerArgument(word: string | undefined, command: string): ProviderId {
  if (word === undefined) throw new UsageError(`${command} needs a provider`);
  if (!isProviderId(word)) throw new UsageError(`unknown provider ${word}`);
  return word;
}

/** Commands that take no arguments refuse every word. */
export function noArguments(args: readonly string[], command: string): void {
  if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
}
