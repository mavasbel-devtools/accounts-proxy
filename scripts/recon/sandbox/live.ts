/**
 * Host-side attribution for the guard.
 *
 * The guard fingerprints real client directories before and after a sandboxed run. A change can mean the sandbox
 * leaked, but it can also mean the operator's own copy of that client is running and writing its own state — opencode
 * keeps a live database, for example. This module answers the second question from `/proc`, so the report does not
 * cry leak over the operator's own session.
 *
 * It is deliberately not a proof of isolation: only the in-sandbox probe is.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { sep } from "node:path";
import { guardedPaths, type ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";

/**
 * True when a host process has an open descriptor under one of the guarded paths.
 *
 * A client daemon does not always carry the client's name on its command line: Codex's managed app-server starts from
 * `~/.codex/packages/app-server-daemon/...` and keeps `logs_2.sqlite*` open there. Matching open descriptors catches it
 * (and any future background writer) without teaching the marker list every install layout.
 */
function holdsPathOpen(pid: string, paths: readonly string[]): boolean {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    if (paths.some((path) => target === path || target.startsWith(path + sep))) return true;
  }
  return false;
}

/** True when a process on the host runs this client's binary (the sandboxed copy is invisible to the host). */
export function clientRunning(client: ReconClient): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return false;
  }
  const guarded = client.guards;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmdline.includes(client.processMarker) || holdsPathOpen(pid, guarded)) return true;
  }
  return false;
}

/** The client whose guarded paths contain `path`, if any. */
export function ownerOfPath(path: string, clients: readonly ReconClient[]): ReconClient | undefined {
  return clients.find((client) =>
    guardedPaths(client).some((guarded) => path === guarded || path.startsWith(guarded + sep)),
  );
}

/** Split changed guarded paths into "owned by a running host client" and everything else. */
export function attributeChanges(
  changed: readonly string[],
  clients: readonly ReconClient[],
): { readonly live: readonly string[]; readonly unexplained: readonly string[] } {
  const running = new Map(clients.map((client) => [client.id, clientRunning(client)]));
  const live: string[] = [];
  const unexplained: string[] = [];
  for (const path of changed) {
    const owner = ownerOfPath(path, clients);
    if (owner !== undefined && running.get(owner.id) === true) live.push(path);
    else unexplained.push(path);
  }
  return { live, unexplained };
}
