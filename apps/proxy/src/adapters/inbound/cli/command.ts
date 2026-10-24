// The command-line framework both command lines build on (the proxy's and the recon tool's): a tree of commands, each
// carrying its own help. A parsing mistake is a UsageError, reported with the usage of the command it belongs to.

export type Writer = (text: string) => void;

/** One row of a help section: an argument, an option, an exit code, a variable or an example. */
export type HelpEntry = { readonly name: string; readonly text: string };

/** Everything `help` prints about a command. Examples are complete command lines, so they run as printed. */
export type CommandHelp = {
  /** The word that selects the command ("" for the program itself). */
  readonly name: string;
  /** Usage lines, without the program name. */
  readonly synopsis: readonly string[];
  /** One line, shown in the parent's list. */
  readonly summary: string;
  /** Paragraphs, wrapped when printed; "" is a blank line. */
  readonly description: readonly string[];
  readonly arguments?: readonly HelpEntry[];
  readonly options?: readonly HelpEntry[];
  readonly exits: readonly HelpEntry[];
  readonly environment?: readonly HelpEntry[];
  readonly examples: readonly HelpEntry[];
  readonly subcommands?: readonly CommandHelp[];
};

/** A wrong command line: exit 2, with the usage of the command it was meant for. */
export class UsageError extends Error {}

/** A command named by a word sequence, with the words left over as its arguments. */
export type Resolved = { readonly command: CliCommand; readonly path: readonly string[]; readonly rest: readonly string[] };

/** A command: its help, and what it does with its arguments (the exit code; nothing means 0). */
export abstract class CliCommand {
  abstract readonly help: CommandHelp;
  abstract run(args: readonly string[], out: Writer): Promise<number | void>;

  /** A command without subcommands takes every remaining word as an argument. */
  resolve(args: readonly string[], path: readonly string[]): Resolved {
    return { command: this, path, rest: args };
  }
}

/** A command that only selects one of its subcommands (`account list`, `account use`; the program itself). */
export abstract class CommandGroup extends CliCommand {
  protected abstract readonly subcommands: readonly CliCommand[];

  override resolve(args: readonly string[], path: readonly string[]): Resolved {
    const sub = this.subcommands.find((command) => command.help.name === args[0]);
    return sub === undefined ? { command: this, path, rest: args } : sub.resolve(args.slice(1), [...path, sub.help.name]);
  }

  /** Reached only when the first word names no subcommand. */
  async run(args: readonly string[]): Promise<number> {
    const names = this.subcommands.map((command) => command.help.name);
    const noun = this.help.name === "" ? "command" : `${this.help.name} subcommand`;
    const word = args[0];
    if (word === undefined) throw new UsageError(`missing ${noun}: one of ${names.join(", ")}`);
    throw new UsageError(`unknown ${noun} ${word}${suggestion(word, names)}`);
  }
}

/** The program: its help is the overview, its subcommands are the commands. */
export class CommandRoot extends CommandGroup {
  constructor(
    readonly help: CommandHelp,
    protected readonly subcommands: readonly CliCommand[],
  ) {
    super();
  }
}

/** `-h` and `--help` ask for the help of the command they follow. */
export function isHelpFlag(word: string): boolean {
  return word === "-h" || word === "--help";
}

/** " (did you mean <name>?)" for the one known name nearest the word, at most two edits away; else "". */
export function suggestion(word: string, names: readonly string[]): string {
  const distances = names.map((name) => editDistance(word, name));
  const nearest = Math.min(...distances);
  const close = names.filter((_, i) => distances[i] === nearest);
  return nearest <= 2 && close.length === 1 ? ` (did you mean ${close[0]}?)` : "";
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = current;
  }
  return previous[b.length]!;
}
