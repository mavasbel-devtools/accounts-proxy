/**
 * Loopback ports owned by a recon profile.
 *
 * The sandbox shares the host's network namespace (a stated residual of the isolation contract), so a client's fixed
 * port is also the host's port. opencode 2.1.1 derives its managed-service port from the release channel — 49374 for
 * `latest` — and reads an override from `<config>/service.json`. When the operator's own session already holds that
 * port, a sandboxed `auth login` dies with EADDRINUSE before it can print a login URL.
 *
 * Allocating a per-profile port and writing it into the profile's own service file removes the collision without
 * touching the operator's configuration: the profile lives outside the repository and outside the real home.
 */

import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/** An ephemeral loopback port, released before it is returned. */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free loopback port"))));
    });
  });
}

/** Bind `port` on loopback, then release it. Throws when the port is already held. */
export async function assertLoopbackPortFree(port: number): Promise<void> {
  await new Promise<void>((resolveBind, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      reject(new Error(`loopback port ${port} is already in use; stop the process holding it or use another profile`));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveBind());
    });
  });
}

/**
 * Merge `port` into a client service file, preserving every other key.
 *
 * The file is created when absent and always written 0600: it may carry a service password alongside the port. A
 * malformed file is replaced only when it is not JSON at all, which can only be the case before any client wrote it.
 */
export function mergeServicePort(file: string, port: number): void {
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (text !== "") {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }
  }
  current.port = port;
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(current, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
}
