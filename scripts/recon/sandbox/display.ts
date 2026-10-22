/**
 * A private X server for GUI clients.
 *
 * The operator's display is never used: the sandbox gets its own Xvfb, its own display number and `-ac` (no xauth),
 * and only that server's unix socket is bind-mounted into the sandbox. The socket directory is shared (X11 has no
 * other transport), but a display number that was free at allocation time is ours alone for the duration of the run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { X11_SOCKET_DIR } from "@accounts-proxy/scripts/recon/sandbox/types.ts";

/** A running private X server. */
export interface PrivateDisplay {
  /** Display name, for example `:97`. */
  readonly name: string;
  readonly child: ChildProcess;
}

/** First display number tried; high numbers avoid the operator's own sessions. */
const FIRST_DISPLAY = 90;
/** Last display number tried. */
const LAST_DISPLAY = 199;

function displaySocket(number: number): string {
  return `${X11_SOCKET_DIR}/X${number}`;
}

function displayLock(number: number): string {
  return `/tmp/.X${number}-lock`;
}

/** Lowest display number that is free right now. */
export function freeDisplayNumber(): number {
  for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number += 1) {
    if (!existsSync(displaySocket(number)) && !existsSync(displayLock(number))) return number;
  }
  throw new Error(`no free X display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`);
}

/** Start Xvfb on a free display and wait for its socket. */
export async function startDisplay(timeoutMs = 15_000): Promise<PrivateDisplay> {
  const number = freeDisplayNumber();
  const name = `:${number}`;
  const child = spawn("Xvfb", [name, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac", "-noreset"], {
    stdio: "ignore",
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(displaySocket(number))) return { name, child };
    if (child.exitCode !== null) throw new Error(`Xvfb ${name} exited with ${child.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`Xvfb ${name} did not create ${displaySocket(number)} within ${timeoutMs} ms`);
}

/** Stop the private X server. */
export async function stopDisplay(display: PrivateDisplay): Promise<void> {
  if (display.child.exitCode !== null) return;
  display.child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      display.child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    display.child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}
