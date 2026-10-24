// The recon command line over a recording ReconActions: every command's arguments, its help in every form, its usage
// errors (exit 2) and the exit codes the operations return. The live operations are exercised by the recon runs.
import { describe, expect, test } from "bun:test";
import type { Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { renderHelp } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";
import { ISOLATION_EXIT, ReconActions, RECON_CLIENTS, type ParityRequest, type ReconClientId, type RunRequest, type WorkflowRequest } from "@accounts-proxy/scripts/recon/cli/actions.ts";
import { RECON_HELP, RECON_PROGRAM, reconCommands } from "@accounts-proxy/scripts/recon/cli/commands.ts";

class Recording extends ReconActions {
  calls: unknown[][] = [];
  exit = 0;
  async clients(out: Writer) {
    this.calls.push(["clients"]);
    out("clients\n");
  }
  async profiles() {
    this.calls.push(["profiles"]);
  }
  async snapshot(client: ReconClientId) {
    this.calls.push(["snapshot", client]);
  }
  async workflows(client: ReconClientId | undefined) {
    this.calls.push(["workflows", client]);
  }
  async workflow(request: WorkflowRequest) {
    this.calls.push(["workflow", request]);
    return this.exit;
  }
  async timeline(runDir: string) {
    this.calls.push(["timeline", runDir]);
  }
  async parity(request: ParityRequest) {
    this.calls.push(["parity", request]);
    return this.exit;
  }
  async isolation(clients: readonly ReconClientId[]) {
    this.calls.push(["isolation", clients]);
    return this.exit;
  }
  async reset(client: ReconClientId) {
    this.calls.push(["reset", client]);
  }
  async run(request: RunRequest) {
    this.calls.push(["run", request]);
    return this.exit;
  }
}

function recon() {
  const actions = new Recording();
  const out: string[] = [];
  const err: string[] = [];
  const driver = new CommandLineDriver(reconCommands(actions), RECON_PROGRAM, (t) => out.push(t), (t) => err.push(t));
  return { actions, out, err, run: (...argv: string[]) => driver.run(argv) };
}

const COMMANDS = ["clients", "profiles", "snapshot", "isolation", "run", "workflows", "workflow", "timeline", "parity", "reset", "help"];

describe("recon command line", () => {
  test("no command, help, --help and -h print the overview listing every command", async () => {
    const r = recon();
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) expect(await r.run(...argv)).toBe(0);
    const overview = renderHelp(RECON_HELP, [], RECON_PROGRAM);
    expect(r.out).toEqual([overview, overview, overview, overview]);
    expect(RECON_HELP.subcommands!.map((help) => help.name)).toEqual(COMMANDS);
    for (const name of COMMANDS) expect(overview).toContain(`\n  ${name}`);
    expect(r.actions.calls).toEqual([]);
  });

  test.each(COMMANDS)("`help %s`, `%s --help` and `%s -h` print the same help, with examples, and run nothing", async (name) => {
    const r = recon();
    expect(await r.run("help", name)).toBe(0);
    expect(await r.run(name, "--help")).toBe(0);
    expect(await r.run(name, "opencode", "-h")).toBe(0);
    expect(r.out[1]).toBe(r.out[0]!);
    expect(r.out[2]).toBe(r.out[0]!);
    expect(r.out[0]!.startsWith(`${RECON_PROGRAM} ${name} — `)).toBe(true);
    for (const section of ["usage:", "options:", "exit codes:", "examples:"]) expect(r.out[0]).toContain(`\n${section}\n`);
    expect(r.err).toEqual([]);
    expect(r.actions.calls).toEqual([]);
  });

  test("every command's help has a description, the usage exit code and examples that start with the program", () => {
    for (const help of RECON_HELP.subcommands!) {
      expect(help.description.length).toBeGreaterThan(0);
      expect(help.exits.map((exit) => exit.name)).toContain("2");
      expect(help.examples.length).toBeGreaterThanOrEqual(1);
      for (const example of help.examples) expect(example.name.startsWith(`${RECON_PROGRAM} `)).toBe(true);
    }
  });

  test("the commands hand their parsed arguments to the operations", async () => {
    const r = recon();
    expect(await r.run("clients")).toBe(0);
    expect(await r.run("profiles")).toBe(0);
    expect(await r.run("snapshot", "codex")).toBe(0);
    expect(await r.run("isolation")).toBe(0);
    expect(await r.run("isolation", "opencode", "claude")).toBe(0);
    expect(await r.run("run", "claude")).toBe(0);
    expect(await r.run("run", "antigravity", "--login", "--fresh", "--prompt=one", "--prompt=two", "--prompt=", "--timeout=1800000", "--target=x")).toBe(0);
    expect(await r.run("run", "opencode", "--verify")).toBe(0);
    expect(await r.run("run", "opencode", "--", "/clients/opencode/opencode", "--help")).toBe(0);
    expect(await r.run("workflows")).toBe(0);
    expect(await r.run("workflows", "claude")).toBe(0);
    expect(await r.run("workflow", "claude", "turn", "--timeout=5000")).toBe(0);
    expect(await r.run("workflow", "opencode", "turn-tools", "--model=opencode-go/m")).toBe(0);
    expect(await r.run("timeline", "/runs/a")).toBe(0);
    expect(await r.run("parity", "/runs/a", "2", "3", "--json=/tmp/p.json")).toBe(0);
    expect(await r.run("parity", "/runs/a", "0")).toBe(0);
    expect(await r.run("reset", "codex", "--yes")).toBe(0);
    expect(r.out).toEqual(["clients\n"]);
    expect(r.actions.calls).toEqual([
      ["clients"],
      ["profiles"],
      ["snapshot", "codex"],
      ["isolation", RECON_CLIENTS],
      ["isolation", ["opencode", "claude"]],
      ["run", { client: "claude", mode: "capture", fresh: false, args: [] }],
      ["run", { client: "antigravity", mode: "login", loginTarget: "x", prompts: ["one", "two"], fresh: true, timeoutMs: 1800000, args: [] }],
      ["run", { client: "opencode", mode: "verify", fresh: false, args: [] }],
      ["run", { client: "opencode", mode: "capture", fresh: false, args: ["/clients/opencode/opencode", "--help"] }],
      ["workflows", undefined],
      ["workflows", "claude"],
      ["workflow", { client: "claude", workflow: "turn", timeoutMs: 5000 }],
      ["workflow", { client: "opencode", workflow: "turn-tools", model: "opencode-go/m" }],
      ["timeline", "/runs/a"],
      ["parity", { runDir: "/runs/a", seqs: [2, 3], jsonFile: "/tmp/p.json" }],
      ["parity", { runDir: "/runs/a", seqs: [0] }],
      ["reset", "codex"],
    ]);
  });

  test("the operations' exit codes are the process's: 1 and the isolation exit", async () => {
    const r = recon();
    r.actions.exit = 1;
    expect(await r.run("parity", "/runs/a", "1")).toBe(1);
    expect(await r.run("workflow", "claude", "turn")).toBe(1);
    r.actions.exit = ISOLATION_EXIT;
    expect(await r.run("isolation")).toBe(ISOLATION_EXIT);
    expect(await r.run("run", "codex")).toBe(ISOLATION_EXIT);
    r.actions.clients = () => Promise.reject(new Error("no bwrap"));
    expect(await r.run("clients")).toBe(1);
    expect(r.err).toEqual(["error: no bwrap\n"]);
  });

  test.each([
    [["clients", "x"], "clients takes no arguments", "clients"],
    [["profiles", "x"], "profiles takes no arguments", "profiles"],
    [["snapshot"], "snapshot needs a client", "snapshot"],
    [["snapshot", "clude"], "unknown client clude (did you mean claude?)", "snapshot"],
    [["snapshot", "claude", "codex"], "snapshot takes one client", "snapshot"],
    [["isolation", "nope"], "unknown client nope", "isolation"],
    [["isolation", "--all"], "unknown isolation option --all", "isolation"],
    [["run"], "run needs a client", "run"],
    [["run", "claude", "codex"], "run takes one client; put the command to run after --", "run"],
    [["run", "claude", "--login", "--verify"], "--login and --verify are separate runs; pick one", "run"],
    [["run", "claude", "--prompt=hi"], "--prompt applies to a --login run: it types the prompt after the client reports signed in", "run"],
    [["run", "claude", "--timeout=0"], "--timeout needs a positive integer of milliseconds", "run"],
    [["run", "claude", "--timeout=1.5"], "--timeout needs a positive integer of milliseconds", "run"],
    [["run", "claude", "--login", "--login"], "--login given twice", "run"],
    [["run", "claude", "--logn"], "unknown run option --logn (did you mean --login?)", "run"],
    [["run", "claude", "--timeout"], "--timeout needs a value: --timeout=<value>", "run"],
    [["run", "claude", "--fresh=yes"], "--fresh takes no value", "run"],
    [["workflows", "a", "b"], "workflows takes at most one client", "workflows"],
    [["workflows", "nope"], "unknown client nope", "workflows"],
    [["workflow", "claude"], "workflow needs a client and one workflow id", "workflow"],
    [["workflow", "claude", "turn", "extra"], "workflow needs a client and one workflow id", "workflow"],
    [["workflow", "claude", "turn", "--model=a/b"], "--model applies to opencode workflows only, not claude", "workflow"],
    [["workflow", "claude", "turn", "--timeout=-1"], "--timeout needs a positive integer of milliseconds", "workflow"],
    [["timeline"], "timeline needs one run directory", "timeline"],
    [["timeline", "a", "b"], "timeline needs one run directory", "timeline"],
    [["parity", "/runs/a"], "parity needs a run directory and one or more capture seq numbers", "parity"],
    [["parity", "/runs/a", "x"], "capture seq x is not a non-negative integer", "parity"],
    [["parity", "/runs/a", "-1"], "capture seq -1 is not a non-negative integer", "parity"],
    [["parity", "/runs/a", "1", "--json="], "--json needs a file", "parity"],
    [["reset", "codex"], "reset deletes the profile and its credentials; pass --yes to confirm", "reset"],
    [["reset", "codex", "claude", "--yes"], "reset takes one client", "reset"],
    [["help", "parit"], "unknown command parit (did you mean parity?)", "help"],
    [["help", "run", "x"], "run has no subcommands", "help"],
    [["isolaton"], "unknown command isolaton (did you mean isolation?)", ""],
  ])("usage error %p → exit 2: %s", async (argv, message, path) => {
    const r = recon();
    expect(await r.run(...argv)).toBe(2);
    expect(r.out).toEqual([]);
    const lines = r.err[0]!.split("\n");
    expect(lines[0]).toBe(message);
    expect(lines[1]!.startsWith(`usage: ${RECON_PROGRAM} `)).toBe(true);
    expect(lines.at(-2)).toBe(`for options, exit codes and examples: ${[RECON_PROGRAM, "help", ...(path === "" ? [] : [path])].join(" ")}`);
    expect(r.actions.calls).toEqual([]);
  });
});
