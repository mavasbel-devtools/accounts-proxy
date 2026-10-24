// `help [<command> [<subcommand>]]`: the full help of the program or of one command.
import { CliCommand, type CommandHelp, type HelpEntry, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { findHelp, renderHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";

/**
 * The help of `help` itself. `levels`: the words it accepts, outermost first (`<command>`, then `<subcommand>` on a
 * program whose commands have subcommands); the examples are the program's own command lines.
 */
export function helpCommandHelp(examples: readonly HelpEntry[], levels: readonly HelpEntry[]): CommandHelp {
  return {
    name: "help",
    synopsis: [`help${levels.map((level) => ` [${level.name}`).join("")}${"]".repeat(levels.length)}`],
    summary: "print the help of the program or of one command",
    description: [
      "With no command: the overview. With a command: its usage, arguments, options with their defaults, exit codes, environment variables and examples. `<command> --help` and `<command> -h` print the same; `--help` or `-h` alone print the overview. Help goes to stdout.",
    ],
    arguments: levels,
    exits: [
      { name: "0", text: "the help was printed" },
      { name: "2", text: "no command has that name (the closest name is suggested)" },
    ],
    examples,
  };
}

export class HelpCommand extends CliCommand {
  constructor(
    private readonly root: CommandHelp,
    private readonly program: string,
    readonly help: CommandHelp,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const found = findHelp(this.root, args);
    out(renderHelp(found.help, found.path, this.program));
  }
}
