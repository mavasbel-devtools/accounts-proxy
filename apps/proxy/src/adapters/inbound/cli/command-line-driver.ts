// Command-line inbound adapter: resolves argv against a command tree and runs the command it names. Exit codes:
// 0 success (and help), 1 the command failed (`error: <message>` on stderr), 2 usage error (the message and the
// usage of the command it was meant for on stderr); a command may return another code it documents.
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import { type CliCommand, isHelpFlag, type Resolved, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { renderHelp, renderUsage } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";
import { Driver } from "@accounts-proxy/proxy/adapters/inbound/driver.ts";

export class CommandLineDriver extends Driver {
  constructor(
    private readonly root: CliCommand,
    private readonly program: string,
    private readonly out: Writer,
    private readonly err: Writer,
  ) {
    super();
  }

  async run(argv: readonly string[]): Promise<number> {
    // Words after `--` belong to whatever the command passes them to, never to this parser.
    const separator = argv.indexOf("--");
    const own = separator < 0 ? argv : argv.slice(0, separator);
    let target: Resolved = { command: this.root, path: [], rest: argv };
    try {
      if (argv.length === 0) {
        this.out(renderHelp(this.root.help, [], this.program));
        return 0;
      }
      if (own.some(isHelpFlag)) {
        target = this.root.resolve(own.filter((word) => !isHelpFlag(word)), []);
        // A group left with a word that names none of its subcommands reports it (a usage error).
        if (target.command.help.subcommands !== undefined && target.rest.length > 0) await target.command.run(target.rest, this.out);
        this.out(renderHelp(target.command.help, target.path, this.program));
        return 0;
      }
      target = this.root.resolve(argv, []);
      return (await target.command.run(target.rest, this.out)) ?? 0;
    } catch (error) {
      if (error instanceof UsageError) {
        this.err(`${error.message}\n${renderUsage(target.command.help, target.path, this.program)}`);
        return 2;
      }
      this.err(`error: ${errorMessage(error)}\n`);
      return 1;
    }
  }
}
