/**
 * Recon CLI (plan 2026-10-19-20-04).
 *
 *   bun scripts/recon/cli.ts clients
 *   bun scripts/recon/cli.ts profiles
 *   bun scripts/recon/cli.ts snapshot <client>
 *   bun scripts/recon/cli.ts isolation [client...]
 *   bun scripts/recon/cli.ts run <client> [--login] [--timeout=<ms>] [-- <args...>]
 *   bun scripts/recon/cli.ts reset <client> --yes
 *
 * `isolation` is the acceptance check: every client is launched for real inside its sandbox with a fast command, the
 * in-sandbox probe must report no leak, and the guard must report no change to the real client directories.
 *
 * `run --login` is done once per profile: the client prints (or asks the opener stub to record) its login URL, the
 * operator opens it on the host, and the tokens are written only inside the profile.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientById, detectVersion, type ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";
import { readLoginRecord } from "@accounts-proxy/scripts/recon/login.ts";
import { compare, markdown } from "@accounts-proxy/scripts/recon/parity/compare.ts";
import { runClient } from "@accounts-proxy/scripts/recon/run.ts";
import { fingerprintPath, type PathFingerprint } from "@accounts-proxy/scripts/recon/sandbox/guard.ts";
import { writeTimeline } from "@accounts-proxy/scripts/recon/timeline.ts";
import { allWorkflows, workflowById } from "@accounts-proxy/scripts/recon/workflows/catalogue.ts";
import {
  ensureProfile,
  hostnameOf,
  machineIdOf,
  profileFor,
  reconRoot,
  resetProfile,
} from "@accounts-proxy/scripts/recon/sandbox/profiles.ts";

const CLIENT_ORDER = ["opencode", "antigravity", "claude", "codex"] as const;

const USAGE = `usage: bun scripts/recon/cli.ts <command>

  clients                     list installed clients and their versions
  profiles                    show the recon root, every profile and its login state
  snapshot <client>           fingerprint the real directories the guard protects
  isolation [client...]       launch every client inside its sandbox and assert zero leak
  run <client> [--login | --verify] [--target=<id>] [--timeout=<ms>] [--prompt=<text>] [--fresh] [-- <args...>]
                              run one client inside its isolated profile, with capture;
                              --login is interactive and stores tokens only in the profile,
                              --verify reports the client's own signed-in state,
                              --prompt types a prompt after a GUI login reports signed in (repeatable:
                              each one is the next turn of the same conversation),
                              --fresh moves the profile aside so the client starts as a first launch
  workflows [client]          list the workflow catalogue and what each one is evidence for
  workflow <client> <id> [--timeout=<ms>] [--model=<provider/model>]
                              run one workflow and write its timeline; --model (opencode only) names the
                              client's own model instead of the profile's default
  timeline <run-dir>          rebuild timeline.json for a finished run
  parity <run-dir> <seq>... [--json=<file>]
                              replay each captured request through a signed-in proxy (hermetic) and list every
                              difference between the client's upstream request and the proxy's
  reset <client> --yes        delete one profile and everything a login stored in it
`;

function printClients(): void {
  for (const id of CLIENT_ORDER) {
    try {
      const client = clientById(id);
      console.log(`${id.padEnd(12)} ${detectVersion(client).padEnd(20)} ${client.cell.padEnd(12)} ${client.binary.source}`);
    } catch (error) {
      console.log(`${id.padEnd(12)} ${"not installed".padEnd(20)} ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** Size of a directory tree, in KiB, without following links. */
function treeSize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += treeSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function loginState(client: ReconClient, home: string): string {
  // The client's own answer first: opencode 2.1.1 stores its credential in SQLite, so counting files would call a
  // signed-in profile empty. A client with neither a probe nor a marker keeps nothing durable, and saying "signed in"
  // for it would overstate what a later run finds.
  if (client.signedIn !== undefined) return client.signedIn(home) ? "signed in" : "signed out";
  if (client.authMarkers.length === 0) return "session-only";
  const markers = client.authMarkers.filter((marker) => existsSync(join(home, marker)));
  return markers.length > 0 ? `signed in (${markers.length})` : "signed out";
}

function printProfiles(): void {
  console.log(`root: ${reconRoot()}`);
  for (const id of CLIENT_ORDER) {
    const profile = profileFor(id);
    let dirs: readonly string[] = [];
    let state = "not installed";
    let markers: readonly string[] = [];
    let client: ReconClient | undefined;
    try {
      client = clientById(id);
      dirs = client.profileDirs;
      markers = client.authMarkers;
      state = loginState(client, profile.home);
    } catch {
      // Not installed; still show the reserved profile location.
    }
    ensureProfile(profile, dirs);
    const size = Math.round(treeSize(profile.home) / 1024);
    const record = readLoginRecord(profile.dir);
    console.log(
      `${id.padEnd(12)} ${state.padEnd(18)} ${`${size} KiB`.padEnd(10)} ${hostnameOf(profile).padEnd(19)} machine ${machineIdOf(profile).slice(0, 12)}  ${profile.home}`,
    );
    if (record !== undefined) {
      const when = record.at.replace("T", " ").slice(0, 19);
      const label =
        record.signedIn === true
          ? client !== undefined && client.authMarkers.length === 0 && client.signedIn === undefined
            ? "signed in (not saved: no credential in the profile)"
            : "signed in"
          : record.signedIn === false
            ? "not signed in"
            : "no marker";
      console.log(`${"".padEnd(12)} login ${when} ${label} (${record.markers.length} marker(s))`);
    }
    if (markers.length > 0) console.log(`${"".padEnd(12)} markers: ${markers.join(", ")}`);
  }
}

function printSnapshot(clientId: string): void {
  const client = clientById(clientId);
  const rows: Record<string, PathFingerprint> = {};
  for (const path of [...client.guards, ...client.identityGuards]) {
    rows[path] = fingerprintPath(path);
  }
  console.log(JSON.stringify(rows, null, 2));
}

/** The workflow catalogue: what each client can be driven to do, and what cannot be driven. */
function printWorkflows(only?: string): void {
  const clients = allWorkflows();
  const ids = only !== undefined ? [only] : Object.keys(clients);
  for (const id of ids) {
    const workflows = clients[id];
    if (workflows === undefined) {
      console.log(`${id}: not installed`);
      continue;
    }
    console.log(`${id} (${workflows.length} workflows)`);
    for (const workflow of workflows) {
      const status = workflow.unsupported === undefined ? `${workflow.steps.length} steps` : "unsupported";
      console.log(`  ${workflow.id.padEnd(12)} ${status.padEnd(12)} ${workflow.title}`);
      if (workflow.unsupported === undefined) console.log(`  ${"".padEnd(12)} ${"".padEnd(12)} ${workflow.purpose}`);
      else console.log(`  ${"".padEnd(12)} ${"".padEnd(12)} ${workflow.unsupported}`);
    }
  }
}

/** Launch every client inside its sandbox with a fast command and report the isolation result. */
async function runIsolation(ids: readonly string[]): Promise<number> {
  const rows: { id: string; version: string; probe: string; guard: string; exit: string; captures: number }[] = [];
  let failed = false;
  for (const id of ids) {
    const client = clientById(id);
    const outcome = await runClient({
      clientId: id,
      mode: "capture",
      args: [client.binary.target, ...client.versionArgs],
      timeoutMs: 30_000,
    });
    const version = outcome.version;
    const probe = outcome.probeOk ? "clean" : "LEAK";
    const guard = outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED (${outcome.changedGuards.length})`;
    // A GUI client has no `--version` to exit on: it is started, observed, and stopped at the timeout.
    const exit = outcome.timedOut && client.gui ? "launched" : String(outcome.exitCode);
    rows.push({ id, version, probe, guard, exit, captures: outcome.captures });
    if (!outcome.probeOk || outcome.changedGuards.length > 0) failed = true;
    if (outcome.timedOut && !client.gui) failed = true;
  }
  console.log(`\n${"client".padEnd(12)} ${"version".padEnd(18)} ${"probe".padEnd(8)} ${"guard".padEnd(12)} ${"exit".padEnd(5)} captures`);
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(12)} ${row.version.padEnd(18)} ${row.probe.padEnd(8)} ${row.guard.padEnd(12)} ${row.exit.padEnd(9)} ${row.captures}`,
    );
  }
  return failed ? 2 : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "clients":
      printClients();
      return 0;
    case "profiles":
      printProfiles();
      return 0;
    case "snapshot": {
      const clientId = rest[0];
      if (!clientId) throw new Error("snapshot needs a client id");
      printSnapshot(clientId);
      return 0;
    }
    case "workflows": {
      const only = rest.find((arg) => !arg.startsWith("-"));
      printWorkflows(only);
      return 0;
    }
    case "workflow": {
      const clientId = rest[0];
      const id = rest[1];
      if (!clientId || !id) throw new Error("workflow needs a client id and a workflow id");
      const modelArg = rest.find((arg) => arg.startsWith("--model="));
      const workflow = workflowById(clientId, id, modelArg === undefined ? {} : { model: modelArg.slice("--model=".length) });
      if (workflow.unsupported !== undefined) {
        throw new Error(`workflow ${clientId}/${id} is unsupported: ${workflow.unsupported}`);
      }
      const timeoutArg = rest.find((arg) => arg.startsWith("--timeout="));
      const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : undefined;
      const outcome = await runClient({
        clientId,
        mode: "workflow",
        args: [],
        workflow: { id, steps: workflow.steps, ...(workflow.expects === undefined ? {} : { expects: workflow.expects }) },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      console.log(`client      ${outcome.client} ${outcome.version}`);
      console.log(`workflow    ${id} (${workflow.steps.length} steps)`);
      console.log(`run         ${outcome.runDir}`);
      console.log(`captures    ${outcome.captures} (${outcome.timelineSteps} step(s), ${outcome.unmarkedFlows} unmarked flow(s))`);
      if (outcome.emptyWorkflow) {
        console.log(
          workflow.expects === undefined || outcome.captures === 0
            ? "evidence    NONE — the workflow ran but recorded no flow (host resolver, proxy, or the UI never loaded)"
            : `evidence    NONE — ${outcome.captures} flow(s), but no request matched ${workflow.expects}`,
        );
      }
      console.log(`exit        ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`);
      if (outcome.loginError !== undefined) console.log(`login       FAILED: ${outcome.loginError}`);
      if (outcome.missingTurn) console.log("evidence    NONE — prompts were given but no turn request was recorded");
      if (outcome.stoppedBySignal !== undefined) console.log(`stopped     by ${outcome.stoppedBySignal}; cleanup ran`);
      const busy = [...new Set([...outcome.volatileGuards, ...outcome.liveGuards])];
      console.log(`isolation   probe ${outcome.probeOk ? "clean" : "LEAK"}${busy.length > 0 ? `, host-busy: ${busy.join(", ")}` : ""}`);
      const guard = outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED: ${outcome.changedGuards.join(", ")}`;
      console.log(`guard       ${guard}`);
      if (outcome.changedGuards.length > 0 || !outcome.probeOk) return 2;
      return outcome.exitCode;
    }
    case "timeline": {
      const runDir = rest[0];
      if (!runDir) throw new Error("timeline needs a run directory");
      const timeline = writeTimeline(runDir);
      console.log(`timeline    ${timeline.steps.length} step(s), summary ${JSON.stringify(timeline.summary)}`);
      return 0;
    }
    case "parity": {
      const runDir = rest[0];
      const seqs = rest.slice(1).filter((arg) => !arg.startsWith("--")).map(Number);
      if (!runDir || seqs.length === 0 || seqs.some((seq) => !Number.isInteger(seq))) throw new Error("parity needs a run directory and one or more capture seq numbers");
      const jsonArg = rest.find((arg) => arg.startsWith("--json="));
      const results: unknown[] = [];
      let totalDifferences = 0;
      for (const comparison of await compare(runDir, seqs)) {
        results.push(comparison);
        console.log(markdown(comparison));
        totalDifferences += comparison.gaps.length;
      }
      if (jsonArg !== undefined) writeFileSync(jsonArg.slice("--json=".length), `${JSON.stringify(results, null, 2)}\n`);
      return totalDifferences === 0 ? 0 : 1;
    }
    case "isolation": {
      const ids = rest.filter((arg) => !arg.startsWith("-"));
      const targeted = ids.length > 0 ? ids : [...CLIENT_ORDER];
      return runIsolation(targeted);
    }
    case "reset": {
      const clientId = rest[0];
      if (!clientId) throw new Error("reset needs a client id");
      if (!rest.includes("--yes")) throw new Error("reset deletes credentials; pass --yes to confirm");
      const profile = profileFor(clientId);
      resetProfile(profile);
      console.log(`removed ${profile.dir}`);
      return 0;
    }
    case "run": {
      const clientId = rest[0];
      if (!clientId) throw new Error("run needs a client id");
      const login = rest.includes("--login");
      const verify = rest.includes("--verify");
      if (login && verify) throw new Error("--login and --verify are separate runs; pick one");
      const targetArg = rest.find((arg) => arg.startsWith("--target="));
      const loginTarget = targetArg?.slice("--target=".length);
      // Antigravity cannot keep a login across runs in the sandbox (its unified-state-sync topics never reach
      // `state.vscdb` there, measured), so one run signs in and captures the first turn in the same client process.
      // Repeatable: each --prompt is one turn of the same conversation, in order.
      const prompts = rest.filter((arg) => arg.startsWith("--prompt=")).map((arg) => arg.slice("--prompt=".length));
      const promptAfterLogin = prompts.length === 0 ? undefined : prompts.filter((prompt) => prompt !== "");
      const timeoutArg = rest.find((arg) => arg.startsWith("--timeout="));
      const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : undefined;
      if (timeoutArg && (!Number.isFinite(timeoutMs) || (timeoutMs ?? 0) <= 0)) {
        throw new Error(`invalid --timeout: ${timeoutArg}`);
      }
      // A first launch shows a sign-in entry that reaches the system browser; a profile that already finished onboarding
      // does not (measured on Antigravity 1.107.0), so a re-login needs the first-launch state.
      const freshProfile = rest.includes("--fresh");
      if (promptAfterLogin !== undefined && !login) {
        throw new Error("--prompt applies to a --login run: it types one prompt after the client reports signed in");
      }
      const separator = rest.indexOf("--");
      const args = separator >= 0 ? rest.slice(separator + 1) : [];
      const outcome = await runClient({
        clientId,
        mode: verify ? "verify" : login ? "login" : "capture",
        args,
        ...(loginTarget === undefined ? {} : { loginTarget }),
        ...(promptAfterLogin === undefined || promptAfterLogin.length === 0 ? {} : { promptAfterLogin }),
        ...(freshProfile ? { freshProfile } : {}),
        ...(login ? { onOpenUrl: (url: string) => console.log(`\nopen on the host:\n  ${url}\n`) } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      console.log(`client      ${outcome.client} ${outcome.version}`);
      console.log(`profile     ${outcome.profileHome}`);
      console.log(`run         ${outcome.runDir}`);
      console.log(`captures    ${outcome.captures} (${outcome.timelineSteps} step(s), ${outcome.unmarkedFlows} unmarked flow(s))`);
      console.log(`exit        ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`);
      if (outcome.loginError !== undefined) console.log(`login       FAILED: ${outcome.loginError}`);
      if (outcome.missingTurn) console.log("evidence    NONE — prompts were given but no turn request was recorded");
      if (outcome.stoppedBySignal !== undefined) console.log(`stopped     by ${outcome.stoppedBySignal}; cleanup ran`);
      const busy = [...new Set([...outcome.volatileGuards, ...outcome.liveGuards])];
      console.log(`isolation   probe ${outcome.probeOk ? "clean" : "LEAK"}${busy.length > 0 ? `, host-busy: ${busy.join(", ")}` : ""}`);
      const guard = outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED: ${outcome.changedGuards.join(", ")}`;
      console.log(`guard       ${guard}${busy.length > 0 ? ` (host-busy: ${busy.join(", ")})` : ""}`);
      if (outcome.openUrls.length > 0) {
        console.log("open on the host:");
        for (const url of outcome.openUrls) console.log(`  ${url}`);
      }
      if (outcome.loginRecord !== undefined) console.log(`login       ${outcome.loginRecord}`);
      if (outcome.changedGuards.length > 0 || !outcome.probeOk) return 2;
      return outcome.exitCode;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
