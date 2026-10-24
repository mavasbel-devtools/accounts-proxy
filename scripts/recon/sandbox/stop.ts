/**
 * Stop a sandboxed client the way the client itself expects to be stopped.
 *
 * The process the run spawns is the outer `bwrap`; with `--unshare-pid` it forks the namespace's init (the inner
 * `bwrap`), which runs the command (`/recon-bin/session` execs the client, so the client is that process). A signal to
 * the outer `bwrap` never reaches the client: `bwrap` does not forward it, and its death kills the namespace's init
 * (`--die-with-parent`), which takes every process in the namespace down with SIGKILL. A client stopped that way runs
 * none of its own shutdown code. Measured on Antigravity 1.107.0 (2026-10-24): a SIGTERM to the outer `bwrap` left
 * `state.vscdb` without a single `antigravityUnifiedStateSync.*` row, the same SIGTERM sent to the client's own process
 * made it quit in 2 s and write all 15 topics, `oauthToken` among them.
 */

import { readFileSync } from "node:fs";

/** The process operations a stop needs; an abstraction so the order of signals can be tested without processes. */
export abstract class ProcessControl {
  /** The direct children of `pid`, in the kernel's order; empty when `pid` has none or is gone. */
  abstract children(pid: number): readonly number[];
  /** Send `signal` to `pid`; false when the process is gone. */
  abstract signal(pid: number, signal: NodeJS.Signals): boolean;
}

/** `/proc/<pid>/task/<pid>/children` and `process.kill`. */
export class ProcProcessControl extends ProcessControl {
  children(pid: number): readonly number[] {
    try {
      return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .split(" ")
        .filter((part) => part.trim() !== "")
        .map(Number);
    } catch {
      return [];
    }
  }

  signal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** The command inside the sandbox: outer `bwrap` → inner `bwrap` (the namespace's init) → command. */
export function sandboxedCommand(control: ProcessControl, outerPid: number): number | undefined {
  const init = control.children(outerPid)[0];
  return init === undefined ? undefined : control.children(init)[0];
}

/** A running sandbox: its outer process id and a promise that settles when that process has exited. */
export interface RunningSandbox {
  readonly pid: number;
  readonly exited: Promise<void>;
}

/** How a stop ended: which process got which signal, in order, and whether the client exited before the grace ran out. */
export interface StopOutcome {
  readonly signals: readonly { readonly target: "command" | "sandbox"; readonly signal: NodeJS.Signals }[];
  readonly graceful: boolean;
}

/**
 * SIGTERM the command inside the sandbox and give it `graceMs` to exit through its own shutdown path; only then the
 * sandbox gets SIGTERM, and SIGKILL `killMs` later.
 */
export async function stopSandboxed(
  control: ProcessControl,
  sandbox: RunningSandbox,
  graceMs: number,
  killMs: number,
): Promise<StopOutcome> {
  const signals: { target: "command" | "sandbox"; signal: NodeJS.Signals }[] = [];
  let exited = false;
  const done = sandbox.exited.then(() => {
    exited = true;
  });
  const within = (ms: number): Promise<boolean> =>
    Promise.race([done.then(() => true), new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(exited), ms).unref())]);
  const command = sandboxedCommand(control, sandbox.pid);
  if (command !== undefined && control.signal(command, "SIGTERM")) {
    signals.push({ target: "command", signal: "SIGTERM" });
    if (await within(graceMs)) return { signals, graceful: true };
  }
  if (exited) return { signals, graceful: signals.length > 0 };
  if (control.signal(sandbox.pid, "SIGTERM")) signals.push({ target: "sandbox", signal: "SIGTERM" });
  if (!(await within(killMs)) && control.signal(sandbox.pid, "SIGKILL")) signals.push({ target: "sandbox", signal: "SIGKILL" });
  await done;
  return { signals, graceful: false };
}
