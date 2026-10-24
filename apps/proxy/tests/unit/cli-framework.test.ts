import { describe, expect, test } from "bun:test";
import { CliCommand, CommandGroup, type CommandHelp, CommandRoot, editDistance, isHelpFlag, suggestion, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { HelpCommand, helpCommandHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-command.ts";
import { findHelp, HELP_WIDTH, hanging, renderHelp, renderUsage, synopses, words } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";
import { Driver } from "@accounts-proxy/proxy/adapters/inbound/driver.ts";

const leaf = (name: string, extra: Partial<CommandHelp> = {}): CommandHelp => ({
  name,
  synopsis: [`${name} <x>`],
  summary: `the ${name} command`,
  description: [],
  exits: [{ name: "0", text: "done" }],
  examples: [{ name: `tool ${name} 1`, text: "an example" }],
  ...extra,
});

class Echo extends CliCommand {
  seen: (readonly string[])[] = [];
  constructor(readonly help: CommandHelp) {
    super();
  }
  async run(args: readonly string[], out: Writer): Promise<number | void> {
    this.seen.push(args);
    if (args[0] === "usage") throw new UsageError("bad words");
    if (args[0] === "fail") throw new Error("broken");
    if (args[0] === "code") return 7;
    out(`ran ${args.join(" ")}\n`);
  }
}

class Group extends CommandGroup {
  constructor(
    readonly help: CommandHelp,
    protected readonly subcommands: readonly CliCommand[],
  ) {
    super();
  }
}

function tool() {
  const go = new Echo(leaf("go"));
  const one = new Echo({ ...leaf("one"), synopsis: ["set one <x>"] });
  const groupHelp: CommandHelp = { ...leaf("set"), synopsis: ["set <one> ..."], subcommands: [one.help] };
  const set = new Group(groupHelp, [one]);
  const helpHelp = helpCommandHelp([{ name: "tool help go", text: "about go" }], [{ name: "<command>", text: "c" }, { name: "<subcommand>", text: "s" }]);
  const rootHelp: CommandHelp = { ...leaf(""), synopsis: ["<command>"], summary: "a tool", subcommands: [go.help, groupHelp, helpHelp] };
  const root = new CommandRoot(rootHelp, [go, set, new HelpCommand(rootHelp, "tool", helpHelp)]);
  const out: string[] = [];
  const err: string[] = [];
  const driver = new CommandLineDriver(root, "tool", (t) => out.push(t), (t) => err.push(t));
  return { go, one, rootHelp, out, err, driver, run: (...argv: string[]) => driver.run(argv) };
}

describe("command framework", () => {
  test("help flags, edit distance and suggestions", () => {
    expect([isHelpFlag("-h"), isHelpFlag("--help"), isHelpFlag("help"), isHelpFlag("-help")]).toEqual([true, true, false, false]);
    expect([editDistance("", "abc"), editDistance("kitten", "sitting"), editDistance("same", "same")]).toEqual([3, 3, 0]);
    expect(suggestion("logn", ["login", "list"])).toBe(" (did you mean login?)");
    expect(suggestion("zzzzzz", ["login", "list"])).toBe("");
    // Two names equally near: no single suggestion.
    expect(suggestion("lis", ["list", "lisp"])).toBe("");
  });

  test("words keep bracketed groups whole; hanging wraps at HELP_WIDTH with the continuation indent", () => {
    expect(words("run <a b> [--x | --y] (c d) e")).toEqual(["run", "<a b>", "[--x | --y]", "(c d)", "e"]);
    expect(words("a] b")).toEqual(["a]", "b"]);
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const lines = hanging("> ", "    ", long);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= HELP_WIDTH)).toBe(true);
    expect(lines[0]!.startsWith("> w0 ")).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("    w"))).toBe(true);
    expect(lines.join(" ").replace(/^> /, "").split(/\s+/)).toEqual(long.split(" "));
    const word = "x".repeat(HELP_WIDTH + 5);
    expect(hanging("", "", word)).toEqual([word]);
    expect(hanging("a ", "", "")).toEqual(["a "]);
  });

  test("renderHelp: sections only when present, wide names on their own line, a blank line before every paragraph", () => {
    const wide = "--a-very-long-option-name=<a-value-name>";
    const text = renderHelp(leaf("x", { description: ["first", "second"], options: [{ name: wide, text: "wide" }], environment: [{ name: "V", text: "a variable" }] }), ["x"], "tool");
    expect(text).toContain("\nfirst\n\nsecond\n");
    expect(text).toContain(`\n  ${wide}\n      wide\n`);
    expect(text).toContain("\nenvironment:\n  V  a variable\n");
    expect(text).not.toContain("arguments:");
    expect(text).not.toContain("commands:");
    const bare = renderHelp(leaf("y", { environment: [] }), [], "tool");
    expect(bare).not.toContain("environment:");
    expect(bare).toContain("\noptions:\n  -h, --help  print this help and exit 0\n");
  });

  test("synopses, renderUsage and findHelp walk the tree", () => {
    const { rootHelp } = tool();
    expect(synopses(rootHelp)).toEqual(["go <x>", "set one <x>", "help [<command> [<subcommand>]]"]);
    expect(renderUsage(rootHelp, [], "tool")).toBe("usage: tool go <x>\n       tool set one <x>\n       tool help [<command> [<subcommand>]]\nfor options, exit codes and examples: tool help\n");
    expect(findHelp(rootHelp, ["set", "one"]).path).toEqual(["set", "one"]);
    expect(() => findHelp(rootHelp, ["st"])).toThrow("unknown command st (did you mean set?)");
    expect(() => findHelp(rootHelp, ["set", "on"])).toThrow("unknown set subcommand on (did you mean one?)");
    expect(() => findHelp(rootHelp, ["go", "x"])).toThrow("go has no subcommands");
  });

  test("helpCommandHelp: the synopsis nests one optional word per level", () => {
    const command = { name: "<command>", text: "c" };
    const help = helpCommandHelp([], [command]);
    expect([help.synopsis, help.arguments]).toEqual([["help [<command>]"], [command]]);
    expect(helpCommandHelp([], [command, { name: "<subcommand>", text: "s" }]).synopsis).toEqual(["help [<command> [<subcommand>]]"]);
    expect(helpCommandHelp([], []).synopsis).toEqual(["help"]);
  });

  test("the driver: commands, their exit codes, help flags, `--`, usage errors and failures", async () => {
    const t = tool();
    expect(t.driver).toBeInstanceOf(Driver);
    expect(await t.run("go", "a", "b")).toBe(0);
    expect(await t.run("go", "code")).toBe(7);
    expect(await t.run("set", "one", "z")).toBe(0);
    // After `--` a help flag belongs to the command's own arguments.
    expect(await t.run("go", "--", "--help")).toBe(0);
    expect(t.go.seen).toEqual([["a", "b"], ["code"], ["--", "--help"]]);
    expect(t.out).toEqual(["ran a b\n", "ran z\n", "ran -- --help\n"]);
    t.out.length = 0;
    expect(await t.run("go", "-h", "--")).toBe(0);
    expect(await t.run("set", "--help")).toBe(0);
    expect(t.out.map((text) => text.split("\n")[0])).toEqual(["tool go — the go command", "tool set — the set command"]);
    expect(t.go.seen).toHaveLength(3);
    expect(await t.run("go", "usage")).toBe(2);
    expect(t.err.at(-1)).toBe("bad words\nusage: tool go <x>\nfor options, exit codes and examples: tool help go\n");
    expect(await t.run("set")).toBe(2);
    expect(t.err.at(-1)!.split("\n")[0]).toBe("missing set subcommand: one of one");
    expect(await t.run("nope")).toBe(2);
    expect(t.err.at(-1)!.split("\n")[0]).toBe("unknown command nope");
    expect(await t.run("go", "fail")).toBe(1);
    expect(t.err.at(-1)).toBe("error: broken\n");
  });
});
