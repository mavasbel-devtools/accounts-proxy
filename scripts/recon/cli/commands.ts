// The recon command line (plan 2026-10-19-20-04): every command with its help, over the ReconActions it drives.
import { CliCommand, type CommandHelp, CommandRoot, type HelpEntry, suggestion, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { HelpCommand, helpCommandHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-command.ts";
import { ISOLATION_EXIT, RECON_CLIENTS, type ReconActions, type ReconClientId } from "@accounts-proxy/scripts/recon/cli/actions.ts";

export const RECON_PROGRAM = "bun scripts/recon/cli.ts";

const CLIENT: HelpEntry = { name: "<client>", text: `one of ${RECON_CLIENTS.join(", ")}` };
const FAILED: HelpEntry = { name: "1", text: "the command failed: `error: <message>` on stderr" };
const USAGE: HelpEntry = { name: "2", text: "usage error: the message and the command's usage on stderr" };
const ISOLATION: HelpEntry = { name: String(ISOLATION_EXIT), text: "isolation failed: the in-sandbox probe found a leak, or a real client directory changed" };
const RECON_HOME: HelpEntry = { name: "ACCOUNTS_PROXY_HOME", text: "the proxy's data directory; the recon root is its recon/ (default ~/.local/share/accounts-proxy/recon)" };
const RECON_ROOT: HelpEntry = { name: "ACCOUNTS_PROXY_RECON_ROOT", text: "the recon root itself, overriding ACCOUNTS_PROXY_HOME (default: unset)" };

function client(word: string | undefined, command: string): ReconClientId {
  if (word === undefined) throw new UsageError(`${command} needs a client`);
  const known = RECON_CLIENTS.find((id) => id === word);
  if (known === undefined) throw new UsageError(`unknown client ${word}${suggestion(word, RECON_CLIENTS)}`);
  return known;
}

/** `--name=value` options and bare flags, each allowed once unless repeatable; any other word is an argument. */
function parseOptions(args: readonly string[], command: string, values: readonly string[], flags: readonly string[], repeatable: readonly string[] = []) {
  const found = new Map<string, string[]>();
  const positional: string[] = [];
  for (const word of args) {
    if (!word.startsWith("--")) {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const name = eq < 0 ? word : word.slice(0, eq);
    if (eq < 0 && values.includes(name)) throw new UsageError(`${name} needs a value: ${name}=<value>`);
    if (eq >= 0 && flags.includes(name)) throw new UsageError(`${name} takes no value`);
    if (eq < 0 ? !flags.includes(name) : !values.includes(name)) {
      throw new UsageError(`unknown ${command} option ${word}${suggestion(name, [...values, ...flags])}`);
    }
    if (found.has(name) && !repeatable.includes(name)) throw new UsageError(`${name} given twice`);
    found.set(name, [...(found.get(name) ?? []), eq < 0 ? "" : word.slice(eq + 1)]);
  }
  return { positional, value: (name: string) => found.get(name)?.[0], all: (name: string) => found.get(name) ?? [], flag: (name: string) => found.has(name) };
}

function milliseconds(text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${name} needs a positive integer of milliseconds`);
  return value;
}

function noArguments(args: readonly string[], command: string): void {
  if (args.length > 0) throw new UsageError(`${command} takes no arguments`);
}

export const CLIENTS_HELP: CommandHelp = {
  name: "clients",
  synopsis: ["clients"],
  summary: "list the installed reference clients and their versions",
  description: ["One line per client: id, version, the proxy cell it stands for, and where its binary was found (or why it is not installed). The version comes from the installed package manifest (Antigravity) or from the client's own version command (the others)."],
  exits: [{ name: "0", text: "the list was printed (also when a client is not installed)" }, FAILED, USAGE],
  examples: [{ name: "bun scripts/recon/cli.ts clients", text: "which clients and versions this machine has" }],
};

export const PROFILES_HELP: CommandHelp = {
  name: "profiles",
  synopsis: ["profiles"],
  summary: "show the recon root, every profile and its login state",
  description: ["One line per profile: login state (the client's own answer where it has one), size, the profile's own hostname and machine id, and its home. The last recorded login and the credential markers follow. A missing profile is created empty."],
  exits: [{ name: "0", text: "the profiles were printed" }, FAILED, USAGE],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [{ name: "bun scripts/recon/cli.ts profiles", text: "which profiles are signed in" }],
};

export const SNAPSHOT_HELP: CommandHelp = {
  name: "snapshot",
  synopsis: ["snapshot <client>"],
  summary: "fingerprint the real client directories the guard protects",
  description: ["Prints, as JSON, the fingerprint of every host directory and identity file the isolation guard compares before and after a run. Nothing is started."],
  arguments: [CLIENT],
  exits: [{ name: "0", text: "the fingerprints were printed" }, FAILED, USAGE],
  examples: [{ name: "bun scripts/recon/cli.ts snapshot opencode", text: "the guard's view of the real opencode directories" }],
};

export const ISOLATION_HELP: CommandHelp = {
  name: "isolation",
  synopsis: ["isolation [<client>...]"],
  summary: "launch each client inside its sandbox and assert zero leak",
  description: ["The acceptance check of the recon facility: each client is started for real inside its profile sandbox with a fast command (`--version`; a GUI client is started and stopped after 30 s), the in-sandbox probe must report `clean` and the guard `unchanged`. A table of client, version, probe, guard, exit and captures follows."],
  arguments: [{ name: "<client>...", text: `the clients to check (default: all of ${RECON_CLIENTS.join(", ")})` }],
  exits: [{ name: "0", text: "every client stayed isolated" }, FAILED, USAGE, { name: String(ISOLATION_EXIT), text: "a probe found a leak, a guard changed, or a CLI client did not exit in time" }],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [
    { name: "bun scripts/recon/cli.ts isolation", text: "check all four clients" },
    { name: "bun scripts/recon/cli.ts isolation opencode claude", text: "check two of them" },
  ],
};

export const RUN_HELP: CommandHelp = {
  name: "run",
  synopsis: ["run <client> [--login | --verify] [--target=<id>] [--timeout=<ms>] [--prompt=<text>]... [--fresh] [-- <args>...]"],
  summary: "run one client inside its isolated profile, with capture",
  description: [
    "Starts the client in its profile sandbox behind the capture proxy and records every flow under the run directory. The command run inside the sandbox is the client's default one (Claude Code and Codex: one short turn; opencode: `--version`; Antigravity: the IDE), its login command with --login, its sign-in status command with --verify, or the words after `--`.",
    "A login is interactive and done once per profile: the URL to open on the host is printed as soon as the client asks for it, and the tokens stay in the profile.",
  ],
  arguments: [CLIENT, { name: "<args>...", text: "after `--`: the whole command to run inside the sandbox, binary first; the client is installed under /clients/<client>/ (default: the client's default command)" }],
  options: [
    { name: "--login", text: "sign the profile in, interactively (default: off)" },
    { name: "--verify", text: "run the client's own sign-in status command; excludes --login (default: off)" },
    { name: "--target=<id>", text: "the integration id a client's login accepts (default: the client's own)" },
    { name: "--timeout=<ms>", text: "stop the client after this many milliseconds, a positive integer (default: the client's run timeout; a CLI login waits without one, a GUI login 600000 ms)" },
    { name: "--prompt=<text>", text: "with --login: type this prompt once the client reports signed in; repeat it for the next turns of the same conversation (default: none)" },
    { name: "--fresh", text: "move the profile aside (renamed, never deleted) so the client starts as a first launch (default: off)" },
  ],
  exits: [{ name: "0", text: "the run finished and produced its evidence" }, { name: "1", text: "the client failed, the login failed or the run lacks its evidence (the `exit` line shows the client's own code)" }, USAGE, ISOLATION],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [
    { name: "bun scripts/recon/cli.ts run claude --login", text: "sign the Claude Code profile in once" },
    { name: "bun scripts/recon/cli.ts run opencode --verify", text: "does the opencode profile still have its sign-in?" },
    { name: "bun scripts/recon/cli.ts run antigravity --login --fresh --prompt='Reply with ok' --timeout=1800000", text: "a first-launch Antigravity sign-in that then sends one turn, within 30 minutes" },
    { name: "bun scripts/recon/cli.ts run opencode -- /clients/opencode/opencode models", text: "run `opencode models` inside the sandbox, with capture" },
  ],
};

export const WORKFLOWS_HELP: CommandHelp = {
  name: "workflows",
  synopsis: ["workflows [<client>]"],
  summary: "list the workflow catalogue and what each workflow is evidence for",
  description: ["Per client: each workflow's id, its step count (or `unsupported` with the reason) and the behaviour it records."],
  arguments: [{ name: "<client>", text: `${CLIENT.text} (default: every installed client)` }],
  exits: [{ name: "0", text: "the catalogue was printed" }, FAILED, USAGE],
  examples: [
    { name: "bun scripts/recon/cli.ts workflows", text: "every client's workflows" },
    { name: "bun scripts/recon/cli.ts workflows claude", text: "Claude Code's workflows" },
  ],
};

export const WORKFLOW_HELP: CommandHelp = {
  name: "workflow",
  synopsis: ["workflow <client> <workflow> [--timeout=<ms>] [--model=<provider>/<model>]"],
  summary: "run one workflow inside the client's profile and write its timeline",
  description: ["Drives the client through the workflow's steps with capture and writes timeline.json in the run directory. The workflow names the request it exists to produce; a run that records none fails."],
  arguments: [CLIENT, { name: "<workflow>", text: "an id from `workflows <client>`: bootstrap, turn, turn-tools, multiturn, abort or error" }],
  options: [
    { name: "--timeout=<ms>", text: "stop the client after this many milliseconds, a positive integer (default: a step's own timeout, else the client's run timeout)" },
    { name: "--model=<provider>/<model>", text: "opencode only: the client's own model id instead of the profile's default (default: the profile's model)" },
  ],
  exits: [{ name: "0", text: "the workflow recorded its evidence" }, { name: "1", text: "the workflow is unsupported, the client failed or no request matched (the `exit` line shows the client's own code)" }, USAGE, ISOLATION],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [
    { name: "bun scripts/recon/cli.ts workflow claude turn", text: "one streamed Claude Code turn" },
    { name: "bun scripts/recon/cli.ts workflow opencode turn-tools --model=opencode-go/gpt-6-luna", text: "an opencode tool loop on an OpenCode Go model" },
  ],
};

export const TIMELINE_HELP: CommandHelp = {
  name: "timeline",
  synopsis: ["timeline <run-dir>"],
  summary: "rebuild timeline.json for a finished run",
  description: ["Reads the run's captures and step marks and writes timeline.json again; prints the step count and the summary."],
  arguments: [{ name: "<run-dir>", text: "a run directory (`run` and `workflow` print it on their `run` line)" }],
  exits: [{ name: "0", text: "the timeline was written" }, FAILED, USAGE],
  examples: [{ name: "bun scripts/recon/cli.ts timeline tests/fixtures/captures/recon-parity/opencode-2.1.1/2026-10-23-03-50-16-workflow", text: "rebuild the timeline of a committed opencode run" }],
};

export const PARITY_HELP: CommandHelp = {
  name: "parity",
  synopsis: ["parity <run-dir> <seq>... [--json=<file>]"],
  summary: "list every difference between the client's upstream request and the proxy's",
  description: ["Hermetic: each captured request is replayed, in order, through a signed-in e2e daemon with replay upstreams, and a TCP tap records the proxy's upstream request with header order and case. Each request's differences are printed as Markdown."],
  arguments: [
    { name: "<run-dir>", text: "a run directory with captures/" },
    { name: "<seq>...", text: "the capture sequence numbers to compare, non-negative integers" },
  ],
  options: [{ name: "--json=<file>", text: "also write every comparison to this file as JSON (default: none)" }],
  exits: [{ name: "0", text: "no request differs" }, { name: "1", text: "at least one difference, or the comparison failed" }, USAGE],
  examples: [
    { name: "bun scripts/recon/cli.ts parity tests/fixtures/captures/recon-parity/claude-2.1.304 18", text: "the Claude Code 2.1.304 turn that `bun run verify` checks" },
    { name: "bun scripts/recon/cli.ts parity tests/fixtures/captures/recon-parity/opencode-2.1.1/2026-10-23-03-50-16-workflow 2 3 4 --json=/tmp/opencode/parity.json", text: "an opencode conversation, also as JSON" },
  ],
};

export const RESET_HELP: CommandHelp = {
  name: "reset",
  synopsis: ["reset <client> --yes"],
  summary: "delete one profile and everything a login stored in it",
  description: ["Removes the client's profile directory, its sign-in included; the next login starts from nothing. Nothing outside the recon root is touched."],
  arguments: [CLIENT],
  options: [{ name: "--yes", text: "confirm the deletion; required" }],
  exits: [{ name: "0", text: "the profile was removed" }, FAILED, USAGE],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [{ name: "bun scripts/recon/cli.ts reset codex --yes", text: "forget the Codex profile and its sign-in" }],
};

export const RECON_HELP_HELP = helpCommandHelp([
  { name: "bun scripts/recon/cli.ts help run", text: "everything about `run`" },
  { name: "bun scripts/recon/cli.ts parity --help", text: "the same with --help" },
], [{ name: "<command>", text: "the command to describe" }]);

export const RECON_HELP: CommandHelp = {
  name: "",
  synopsis: ["<command> [<arguments>]", "help [<command>]"],
  summary: "run the reference clients in isolated sandboxes and compare their traffic with the proxy's",
  description: [
    "Every reference client runs only inside its bubblewrap profile sandbox, with its own home, XDG tree, machine id, hostname, users and per-run CA, behind a capturing proxy whose records are redacted before they reach disk (AGENTS.md, Recon facility). Run it from the repository root.",
    `clients: ${RECON_CLIENTS.join(", ")}`,
  ],
  exits: [{ name: "0", text: "success; also every help" }, FAILED, USAGE, ISOLATION],
  environment: [RECON_HOME, RECON_ROOT],
  examples: [
    { name: "bun scripts/recon/cli.ts isolation", text: "the acceptance check" },
    { name: "bun scripts/recon/cli.ts workflow claude turn", text: "record one Claude Code turn" },
    { name: "bun scripts/recon/cli.ts help parity", text: "the options, exit codes and examples of one command" },
  ],
  subcommands: [CLIENTS_HELP, PROFILES_HELP, SNAPSHOT_HELP, ISOLATION_HELP, RUN_HELP, WORKFLOWS_HELP, WORKFLOW_HELP, TIMELINE_HELP, PARITY_HELP, RESET_HELP, RECON_HELP_HELP],
};

abstract class ReconCommand extends CliCommand {
  constructor(protected readonly actions: ReconActions) {
    super();
  }
}

export class ClientsCommand extends ReconCommand {
  readonly help = CLIENTS_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "clients");
    await this.actions.clients(out);
  }
}

export class ProfilesCommand extends ReconCommand {
  readonly help = PROFILES_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "profiles");
    await this.actions.profiles(out);
  }
}

export class SnapshotCommand extends ReconCommand {
  readonly help = SNAPSHOT_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    const id = client(args[0], "snapshot");
    if (args.length > 1) throw new UsageError("snapshot takes one client");
    await this.actions.snapshot(id, out);
  }
}

export class IsolationCommand extends ReconCommand {
  readonly help = ISOLATION_HELP;
  async run(args: readonly string[], out: Writer): Promise<number> {
    const { positional } = parseOptions(args, "isolation", [], []);
    const ids = positional.map((word) => client(word, "isolation"));
    return this.actions.isolation(ids.length > 0 ? ids : RECON_CLIENTS, out);
  }
}

export class RunCommand extends ReconCommand {
  readonly help = RUN_HELP;
  async run(args: readonly string[], out: Writer): Promise<number> {
    const separator = args.indexOf("--");
    const own = separator < 0 ? args : args.slice(0, separator);
    const options = parseOptions(own, "run", ["--target", "--timeout", "--prompt"], ["--login", "--verify", "--fresh"], ["--prompt"]);
    const id = client(options.positional[0], "run");
    if (options.positional.length > 1) throw new UsageError("run takes one client; put the command to run after --");
    const login = options.flag("--login");
    const verify = options.flag("--verify");
    if (login && verify) throw new UsageError("--login and --verify are separate runs; pick one");
    const prompts = options.all("--prompt").filter((prompt) => prompt !== "");
    if (options.flag("--prompt") && !login) throw new UsageError("--prompt applies to a --login run: it types the prompt after the client reports signed in");
    const timeoutMs = milliseconds(options.value("--timeout"), "--timeout");
    const target = options.value("--target");
    return this.actions.run(
      {
        client: id,
        mode: verify ? "verify" : login ? "login" : "capture",
        ...(target === undefined ? {} : { loginTarget: target }),
        ...(prompts.length === 0 ? {} : { prompts }),
        fresh: options.flag("--fresh"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        args: separator < 0 ? [] : args.slice(separator + 1),
      },
      out,
    );
  }
}

export class WorkflowsCommand extends ReconCommand {
  readonly help = WORKFLOWS_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    if (args.length > 1) throw new UsageError("workflows takes at most one client");
    await this.actions.workflows(args[0] === undefined ? undefined : client(args[0], "workflows"), out);
  }
}

export class WorkflowCommand extends ReconCommand {
  readonly help = WORKFLOW_HELP;
  async run(args: readonly string[], out: Writer): Promise<number> {
    const options = parseOptions(args, "workflow", ["--timeout", "--model"], []);
    const id = client(options.positional[0], "workflow");
    const workflow = options.positional[1];
    if (workflow === undefined || options.positional.length > 2) throw new UsageError("workflow needs a client and one workflow id");
    const model = options.value("--model");
    if (model !== undefined && id !== "opencode") throw new UsageError(`--model applies to opencode workflows only, not ${id}`);
    const timeoutMs = milliseconds(options.value("--timeout"), "--timeout");
    return this.actions.workflow({ client: id, workflow, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(model === undefined ? {} : { model }) }, out);
  }
}

export class TimelineCommand extends ReconCommand {
  readonly help = TIMELINE_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    if (args.length !== 1) throw new UsageError("timeline needs one run directory");
    await this.actions.timeline(args[0]!, out);
  }
}

export class ParityCommand extends ReconCommand {
  readonly help = PARITY_HELP;
  async run(args: readonly string[], out: Writer): Promise<number> {
    const options = parseOptions(args, "parity", ["--json"], []);
    const [runDir, ...seqWords] = options.positional;
    if (runDir === undefined || seqWords.length === 0) throw new UsageError("parity needs a run directory and one or more capture seq numbers");
    const seqs = seqWords.map(Number);
    const bad = seqWords.find((_, i) => !Number.isInteger(seqs[i]) || seqs[i]! < 0);
    if (bad !== undefined) throw new UsageError(`capture seq ${bad} is not a non-negative integer`);
    const jsonFile = options.value("--json");
    if (jsonFile === "") throw new UsageError("--json needs a file");
    return this.actions.parity({ runDir, seqs, ...(jsonFile === undefined ? {} : { jsonFile }) }, out);
  }
}

export class ResetCommand extends ReconCommand {
  readonly help = RESET_HELP;
  async run(args: readonly string[], out: Writer): Promise<void> {
    const options = parseOptions(args, "reset", [], ["--yes"]);
    const id = client(options.positional[0], "reset");
    if (options.positional.length > 1) throw new UsageError("reset takes one client");
    if (!options.flag("--yes")) throw new UsageError("reset deletes the profile and its credentials; pass --yes to confirm");
    await this.actions.reset(id, out);
  }
}

/** The recon command tree over the given operations. */
export function reconCommands(actions: ReconActions): CliCommand {
  return new CommandRoot(RECON_HELP, [
    new ClientsCommand(actions),
    new ProfilesCommand(actions),
    new SnapshotCommand(actions),
    new IsolationCommand(actions),
    new RunCommand(actions),
    new WorkflowsCommand(actions),
    new WorkflowCommand(actions),
    new TimelineCommand(actions),
    new ParityCommand(actions),
    new ResetCommand(actions),
    new HelpCommand(RECON_HELP, RECON_PROGRAM, RECON_HELP_HELP),
  ]);
}
