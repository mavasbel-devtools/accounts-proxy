// Renders a command's help and usage, and finds a command's help by its words. Pure text.
import { type CommandHelp, type HelpEntry, suggestion, UsageError } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";

const HELP_OPTION: HelpEntry = { name: "-h, --help", text: "print this help and exit 0" };

/** The synopsis lines of every command below a group, in order; a command's own lines otherwise. */
export function synopses(help: CommandHelp): readonly string[] {
  return help.subcommands === undefined ? help.synopsis : help.subcommands.flatMap((sub) => synopses(sub));
}

/** Help lines stay within this many columns; a word longer than a line stays whole. */
export const HELP_WIDTH = 110;
const NAME_COLUMN = 36;

/**
 * The words of `text`; a space inside brackets does not separate words, so a synopsis keeps `[--login | --verify]` and
 * `<provider>/<model>` whole.
 */
export function words(text: string): string[] {
  const found: string[] = [];
  let word = "";
  let depth = 0;
  for (const char of text) {
    if (char === "[" || char === "<" || char === "(") depth += 1;
    else if ((char === "]" || char === ">" || char === ")") && depth > 0) depth -= 1;
    if (char === " " && depth === 0) {
      found.push(word);
      word = "";
    } else word += char;
  }
  return [...found, word];
}

/** `text` packed into lines of at most HELP_WIDTH columns: the first starts with `first`, the others with `next`. */
export function hanging(first: string, next: string, text: string): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of words(text)) {
    if (!empty && line.length + 1 + word.length > HELP_WIDTH) {
      lines.push(line);
      line = `${next}${word}`;
    } else line = empty ? `${line}${word}` : `${line} ${word}`;
    empty = false;
  }
  return [...lines, line];
}

function entries(title: string, rows: readonly HelpEntry[] | undefined): string[] {
  if (rows === undefined || rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.name.length));
  if (width > NAME_COLUMN) {
    // Names too wide for a column: each name on its own line, its text indented below it.
    return ["", `${title}:`, ...rows.flatMap((row) => [...hanging("  ", "      ", row.name), ...hanging("      ", "      ", row.text)])];
  }
  const indent = " ".repeat(width + 4);
  return ["", `${title}:`, ...rows.flatMap((row) => hanging(`  ${row.name.padEnd(width)}  `, indent, row.text))];
}

/** The full help of one command (`help <words>`, `<words> --help`). */
export function renderHelp(help: CommandHelp, path: readonly string[], program: string): string {
  const title = [program, ...path].join(" ");
  const commands = help.subcommands?.flatMap((sub) => sub.subcommands === undefined ? [{ name: sub.synopsis[0]!, text: sub.summary }] : sub.subcommands.map((leaf) => ({ name: leaf.synopsis[0]!, text: leaf.summary })));
  const lines = [
    ...hanging("", "  ", `${title} — ${help.summary}`),
    "",
    "usage:",
    ...help.synopsis.flatMap((line) => hanging("  ", "      ", `${program} ${line}`)),
    ...help.description.flatMap((paragraph) => ["", ...hanging("", "", paragraph)]),
    ...entries("commands", commands),
    ...entries("arguments", help.arguments),
    ...entries("options", [...(help.options ?? []), HELP_OPTION]),
    ...entries("exit codes", help.exits),
    ...entries("environment", help.environment),
    "",
    "examples:",
    ...help.examples.flatMap((example) => [`  ${example.name}`, ...hanging("      ", "      ", example.text)]),
  ];
  return `${lines.join("\n")}\n`;
}

/** What a usage error prints after its message: the usage lines and where the full help is. */
export function renderUsage(help: CommandHelp, path: readonly string[], program: string): string {
  const [first, ...more] = synopses(help);
  const indent = " ".repeat("usage: ".length);
  const cont = `${indent}    `;
  return [...hanging("usage: ", cont, `${program} ${first}`), ...more.flatMap((line) => hanging(indent, cont, `${program} ${line}`)), `for options, exit codes and examples: ${[program, "help", ...path].join(" ")}`].join("\n") + "\n";
}

/** The help a word sequence names (`help account list`); a word that names nothing is a usage error. */
export function findHelp(root: CommandHelp, words: readonly string[]): { readonly help: CommandHelp; readonly path: readonly string[] } {
  let help = root;
  const path: string[] = [];
  for (const word of words) {
    const names = help.subcommands?.map((sub) => sub.name) ?? [];
    const next = help.subcommands?.find((sub) => sub.name === word);
    if (next === undefined) {
      const owner = path.length === 0 ? "command" : `${path.join(" ")} subcommand`;
      throw new UsageError(names.length === 0 ? `${path.join(" ")} has no subcommands` : `unknown ${owner} ${word}${suggestion(word, names)}`);
    }
    help = next;
    path.push(word);
  }
  return { help, path };
}
