// The recon operations on this machine: the installed clients, their sandbox profiles, capture runs and parity.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { ISOLATION_EXIT, type ParityRequest, RECON_CLIENTS, ReconActions, type ReconClientId, type RunRequest, type WorkflowRequest } from "@accounts-proxy/scripts/recon/cli/actions.ts";
import { clientById, detectVersion, type ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";
import { readLoginRecord } from "@accounts-proxy/scripts/recon/login.ts";
import { compare, markdown } from "@accounts-proxy/scripts/recon/parity/compare.ts";
import { runClient } from "@accounts-proxy/scripts/recon/run.ts";
import { fingerprintPath, type PathFingerprint } from "@accounts-proxy/scripts/recon/sandbox/guard.ts";
import { ensureProfile, hostnameOf, machineIdOf, profileFor, reconRoot, resetProfile } from "@accounts-proxy/scripts/recon/sandbox/profiles.ts";
import { writeTimeline } from "@accounts-proxy/scripts/recon/timeline.ts";
import { allWorkflows, workflowById } from "@accounts-proxy/scripts/recon/workflows/catalogue.ts";

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

/** A run's exit code: 0 when it produced its evidence, 1 when it failed, ISOLATION_EXIT on a leak or a guard change. */
function runExit(outcome: { readonly exitCode: number; readonly probeOk: boolean; readonly changedGuards: readonly string[] }): number {
  if (outcome.changedGuards.length > 0 || !outcome.probeOk) return ISOLATION_EXIT;
  return outcome.exitCode === 0 ? 0 : 1;
}

export class LiveReconActions extends ReconActions {
  async clients(out: Writer): Promise<void> {
    for (const id of RECON_CLIENTS) {
      try {
        const client = clientById(id);
        out(`${id.padEnd(12)} ${detectVersion(client).padEnd(20)} ${client.cell.padEnd(12)} ${client.binary.source}\n`);
      } catch (error) {
        out(`${id.padEnd(12)} ${"not installed".padEnd(20)} ${error instanceof Error ? error.message : error}\n`);
      }
    }
  }

  async profiles(out: Writer): Promise<void> {
    out(`root: ${reconRoot()}\n`);
    for (const id of RECON_CLIENTS) {
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
      out(`${id.padEnd(12)} ${state.padEnd(18)} ${`${size} KiB`.padEnd(10)} ${hostnameOf(profile).padEnd(19)} machine ${machineIdOf(profile).slice(0, 12)}  ${profile.home}\n`);
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
        out(`${"".padEnd(12)} login ${when} ${label} (${record.markers.length} marker(s))\n`);
      }
      if (markers.length > 0) out(`${"".padEnd(12)} markers: ${markers.join(", ")}\n`);
    }
  }

  async snapshot(clientId: ReconClientId, out: Writer): Promise<void> {
    const client = clientById(clientId);
    const rows: Record<string, PathFingerprint> = {};
    for (const path of [...client.guards, ...client.identityGuards]) rows[path] = fingerprintPath(path);
    out(`${JSON.stringify(rows, null, 2)}\n`);
  }

  /** The workflow catalogue: what each client can be driven to do, and what cannot be driven. */
  async workflows(only: ReconClientId | undefined, out: Writer): Promise<void> {
    const clients = allWorkflows();
    const ids = only !== undefined ? [only] : Object.keys(clients);
    for (const id of ids) {
      const workflows = clients[id];
      if (workflows === undefined) {
        out(`${id}: not installed\n`);
        continue;
      }
      out(`${id} (${workflows.length} workflows)\n`);
      for (const workflow of workflows) {
        const status = workflow.unsupported === undefined ? `${workflow.steps.length} steps` : "unsupported";
        out(`  ${workflow.id.padEnd(12)} ${status.padEnd(12)} ${workflow.title}\n`);
        out(`  ${"".padEnd(12)} ${"".padEnd(12)} ${workflow.unsupported ?? workflow.purpose}\n`);
      }
    }
  }

  async workflow(request: WorkflowRequest, out: Writer): Promise<number> {
    const { client: clientId, workflow: id } = request;
    const workflow = workflowById(clientId, id, request.model === undefined ? {} : { model: request.model });
    if (workflow.unsupported !== undefined) throw new Error(`workflow ${clientId}/${id} is unsupported: ${workflow.unsupported}`);
    const outcome = await runClient({
      clientId,
      mode: "workflow",
      args: [],
      workflow: { id, steps: workflow.steps, ...(workflow.expects === undefined ? {} : { expects: workflow.expects }) },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    out(`client      ${outcome.client} ${outcome.version}\n`);
    out(`workflow    ${id} (${workflow.steps.length} steps)\n`);
    out(`run         ${outcome.runDir}\n`);
    out(`captures    ${outcome.captures} (${outcome.timelineSteps} step(s), ${outcome.unmarkedFlows} unmarked flow(s))\n`);
    if (outcome.emptyWorkflow) {
      out(
        workflow.expects === undefined || outcome.captures === 0
          ? "evidence    NONE — the workflow ran but recorded no flow (host resolver, proxy, or the UI never loaded)\n"
          : `evidence    NONE — ${outcome.captures} flow(s), but no request matched ${workflow.expects}\n`,
      );
    }
    out(`exit        ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}\n`);
    if (outcome.loginError !== undefined) out(`login       FAILED: ${outcome.loginError}\n`);
    if (outcome.missingTurn) out("evidence    NONE — prompts were given but no turn request was recorded\n");
    if (outcome.stoppedBySignal !== undefined) out(`stopped     by ${outcome.stoppedBySignal}; cleanup ran\n`);
    const busy = [...new Set([...outcome.volatileGuards, ...outcome.liveGuards])];
    out(`isolation   probe ${outcome.probeOk ? "clean" : "LEAK"}${busy.length > 0 ? `, host-busy: ${busy.join(", ")}` : ""}\n`);
    out(`guard       ${outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED: ${outcome.changedGuards.join(", ")}`}\n`);
    return runExit(outcome);
  }

  async timeline(runDir: string, out: Writer): Promise<void> {
    const timeline = writeTimeline(runDir);
    out(`timeline    ${timeline.steps.length} step(s), summary ${JSON.stringify(timeline.summary)}\n`);
  }

  async parity(request: ParityRequest, out: Writer): Promise<number> {
    const results: unknown[] = [];
    let differences = 0;
    for (const comparison of await compare(request.runDir, request.seqs)) {
      results.push(comparison);
      out(`${markdown(comparison)}\n`);
      differences += comparison.gaps.length;
    }
    if (request.jsonFile !== undefined) writeFileSync(request.jsonFile, `${JSON.stringify(results, null, 2)}\n`);
    return differences === 0 ? 0 : 1;
  }

  /** Launch every client inside its sandbox with a fast command and report the isolation result. */
  async isolation(ids: readonly ReconClientId[], out: Writer): Promise<number> {
    const rows: { id: string; version: string; probe: string; guard: string; exit: string; captures: number }[] = [];
    let failed = false;
    for (const id of ids) {
      const client = clientById(id);
      const outcome = await runClient({ clientId: id, mode: "capture", args: [client.binary.target, ...client.versionArgs], timeoutMs: 30_000 });
      // A GUI client has no `--version` to exit on: it is started, observed, and stopped at the timeout.
      const exit = outcome.timedOut && client.gui ? "launched" : String(outcome.exitCode);
      rows.push({ id, version: outcome.version, probe: outcome.probeOk ? "clean" : "LEAK", guard: outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED (${outcome.changedGuards.length})`, exit, captures: outcome.captures });
      if (!outcome.probeOk || outcome.changedGuards.length > 0) failed = true;
      if (outcome.timedOut && !client.gui) failed = true;
    }
    out(`\n${"client".padEnd(12)} ${"version".padEnd(18)} ${"probe".padEnd(8)} ${"guard".padEnd(12)} ${"exit".padEnd(5)} captures\n`);
    for (const row of rows) out(`${row.id.padEnd(12)} ${row.version.padEnd(18)} ${row.probe.padEnd(8)} ${row.guard.padEnd(12)} ${row.exit.padEnd(9)} ${row.captures}\n`);
    return failed ? ISOLATION_EXIT : 0;
  }

  async reset(clientId: ReconClientId, out: Writer): Promise<void> {
    const profile = profileFor(clientId);
    resetProfile(profile);
    out(`removed ${profile.dir}\n`);
  }

  async run(request: RunRequest, out: Writer): Promise<number> {
    const login = request.mode === "login";
    const outcome = await runClient({
      clientId: request.client,
      mode: request.mode,
      args: request.args,
      ...(request.loginTarget === undefined ? {} : { loginTarget: request.loginTarget }),
      ...(request.prompts === undefined || request.prompts.length === 0 ? {} : { promptAfterLogin: request.prompts }),
      ...(request.fresh ? { freshProfile: true } : {}),
      ...(login ? { onOpenUrl: (url: string) => out(`\nopen on the host:\n  ${url}\n\n`) } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    out(`client      ${outcome.client} ${outcome.version}\n`);
    out(`profile     ${outcome.profileHome}\n`);
    out(`run         ${outcome.runDir}\n`);
    out(`captures    ${outcome.captures} (${outcome.timelineSteps} step(s), ${outcome.unmarkedFlows} unmarked flow(s))\n`);
    out(`exit        ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}\n`);
    if (outcome.loginError !== undefined) out(`login       FAILED: ${outcome.loginError}\n`);
    if (outcome.missingTurn) out("evidence    NONE — prompts were given but no turn request was recorded\n");
    if (outcome.stoppedBySignal !== undefined) out(`stopped     by ${outcome.stoppedBySignal}; cleanup ran\n`);
    const busy = [...new Set([...outcome.volatileGuards, ...outcome.liveGuards])];
    out(`isolation   probe ${outcome.probeOk ? "clean" : "LEAK"}${busy.length > 0 ? `, host-busy: ${busy.join(", ")}` : ""}\n`);
    const guard = outcome.changedGuards.length === 0 ? "unchanged" : `CHANGED: ${outcome.changedGuards.join(", ")}`;
    out(`guard       ${guard}${busy.length > 0 ? ` (host-busy: ${busy.join(", ")})` : ""}\n`);
    if (outcome.openUrls.length > 0) {
      out("open on the host:\n");
      for (const url of outcome.openUrls) out(`  ${url}\n`);
    }
    if (outcome.loginRecord !== undefined) out(`login       ${outcome.loginRecord}\n`);
    return runExit(outcome);
  }
}
