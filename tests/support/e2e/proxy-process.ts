// Runs the real `accounts-proxy` entry (apps/proxy/src/main/cli.ts) as a child process under the e2e coverage
// preload (AGENTS.md §5): every source file the process loads is instrumented, and the process writes its coverage on
// a normal exit. The child gets its own data directory, the replay seams and a PATH whose first `xdg-open` is the fake
// browser. A daemon is stopped with SIGTERM, which it handles (ProcessShutdownSignal), so it exits normally.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { makeTemporary, temporaryRoot } from "@accounts-proxy/test-support/temporary.ts";

const repo = join(import.meta.dir, "..", "..", "..");
export const ENTRY = join(repo, "apps", "proxy", "src", "main", "cli.ts");
const PRELOAD = join(repo, "scripts", "gate", "e2e-coverage-preload.ts");

export type Home = { readonly dir: string; readonly port: number; readonly browserLog: string; readonly bin: string };

/** The accounts file of a test home (plan 2026-10-26-23-32): every e2e process is pointed at it. */
export const accountsFile = (home: Home) => join(home.dir, "accounts.json");

/** The log folder of a test home: `logs/` next to its accounts file (plan 2026-10-27-23-29 L1). */
export const logsDir = (home: Home) => join(home.dir, "logs");

/** The log files of one kind, every process's, in name order (`<day>-<pid>-<kind>[.<n>].<ext>`, L2). */
export function logFiles(home: Home, kind: "usage" | "proxy"): string[] {
  if (!existsSync(logsDir(home))) return [];
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d+-${kind}(\\.\\d+)?\\.(jsonl|log)$`);
  return readdirSync(logsDir(home)).filter((name) => pattern.test(name)).sort();
}

/** Every daemon-log line of a home, all processes (the files a process wrote are complete once it has exited). */
export function proxyLogOf(home: Home): string {
  return logFiles(home, "proxy").map((name) => readFileSync(join(logsDir(home), name), "utf8")).join("");
}

/**
 * Waits until the proxy log of a home contains `text` (5 s at most): a running daemon's winston stream writes a line
 * shortly after the answer that caused it, so a log read right after a response can precede the line (L3a).
 */
export async function loggedEventually(home: Home, text: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const log = proxyLogOf(home);
    if (log.includes(text)) return log;
    await Bun.sleep(50);
  }
  return proxyLogOf(home);
}

/** Every usage record of a home, all processes, parsed. */
export function usageOf(home: Home): Record<string, unknown>[] {
  return logFiles(home, "usage")
    .flatMap((name) => readFileSync(join(logsDir(home), name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Waits (up to 5 s) until a running daemon's log has the text: the daemon writes its files asynchronously. */
export async function proxyLogWith(home: Home, text: string): Promise<string> {
  for (let i = 0; i < 500 && !proxyLogOf(home).includes(text); i++) await Bun.sleep(10);
  return proxyLogOf(home);
}

type StoredPool = { accounts: { provider: string; id: string; label: string; needsLogin?: string; data: Record<string, unknown> }[]; activeId?: string };

/** One provider's pool as stored in the home's accounts file (undefined when the provider has none). */
export function readPool(home: Home, provider: string): StoredPool | undefined {
  if (!existsSync(accountsFile(home))) return undefined;
  return (JSON.parse(readFileSync(accountsFile(home), "utf8")) as { providers: Record<string, StoredPool> }).providers[provider];
}

/** Sets one provider's pool in the home's accounts file (0600), keeping the other providers. */
export function writePool(home: Home, provider: string, pool: unknown): void {
  const current = existsSync(accountsFile(home)) ? (JSON.parse(readFileSync(accountsFile(home), "utf8")) as { providers: Record<string, unknown> }) : { providers: {} };
  writeFileSync(accountsFile(home), JSON.stringify({ schema: "accounts-proxy/accounts/1", providers: { ...current.providers, [provider]: pool } }), { mode: 0o600 });
}

// A claim is a file holding the claiming test process's pid, so parallel test processes never share a port. A claim
// whose process has exited is stale and taken over: claims are never left to pile up across runs (the former
// directory-per-port claims were never released and, on a disk-backed /tmp, came to cover every port the kernel hands
// out, so freePort looped forever).
const claimDir = join(temporaryRoot(), "accounts-proxy-port-claims");
mkdirSync(claimDir, { recursive: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claim(port: number): boolean {
  const file = join(claimDir, String(port));
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    const owner = Number.parseInt(readFileSync(file, "utf8"), 10);
    if (owner === process.pid || (Number.isInteger(owner) && alive(owner))) return false;
    // Only one process wins the rename of a stale claim, so a fresh claim is never removed by a slower process.
    const stale = `${file}.stale-${process.pid}`;
    try {
      renameSync(file, stale);
    } catch {
      return false;
    }
    rmSync(stale, { force: true });
    return claim(port);
  }
}

export async function freePort(): Promise<number> {
  while (true) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (claim(port)) return port;
    await Bun.sleep(5);
  }
}

export const BOTH_PROVIDERS = "providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n";

/** A fresh data directory with proxy.yaml (a free port unless given) and the fake browser on a private bin dir. */
export async function makeHome(yaml: string = BOTH_PROVIDERS, port?: number): Promise<Home> {
  const dir = makeTemporary("proxy-e2e");
  const chosen = port ?? (await freePort());
  writeFileSync(join(dir, "proxy.yaml"), `port: ${chosen}\n${yaml}`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const opener = join(bin, "xdg-open");
  writeFileSync(opener, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-browser.ts")}" "$1"\n`);
  chmodSync(opener, 0o755);
  return { dir, port: chosen, browserLog: join(dir, "browser.log"), bin };
}

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The child's environment: the test process's (without seams or hooks), the home's variables, then `extra`, where an
 * empty value removes the variable (e.g. ACCOUNTS_PROXY_HOME, to exercise the default data directory). */
function environment(home: Home, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ACCOUNTS_PROXY_TEST_")) env[k] = v;
  // XDG_DATA_HOME: OpenCode's credential file (`login --from-opencode`) is read only from inside the home, never the user's.
  // ACCOUNTS_PROXY_ACCOUNTS_FILE: the accounts file (and its locks) inside the home, never the repository's .cache/.
  const merged: Record<string, string> = { ...env, ACCOUNTS_PROXY_HOME: home.dir, ACCOUNTS_PROXY_ACCOUNTS_FILE: accountsFile(home), ACCOUNTS_PROXY_E2E_BROWSER_LOG: home.browserLog, XDG_DATA_HOME: join(home.dir, "xdg-data"), PATH: `${home.bin}:${process.env["PATH"] ?? ""}`, ...extra };
  for (const [k, v] of Object.entries(merged)) if (v === "") delete merged[k];
  return merged;
}

function spawnProxy(home: Home, argv: readonly string[], env: Record<string, string>) {
  return Bun.spawn([process.execPath, "--preload", PRELOAD, ENTRY, ...argv], { cwd: repo, env: environment(home, env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** One CLI command to completion; `input` is written to stdin when given (the paste-code prompt). */
export async function runProxy(home: Home, argv: readonly string[], env: Record<string, string> = {}, input?: (stdout: () => string) => Promise<string>): Promise<Result> {
  const child = spawnProxy(home, argv, env);
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  if (input !== undefined) child.stdin.write(await input(() => stdout));
  child.stdin.end();
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), reading]);
  return { code, stdout, stderr };
}

const START_TIMEOUT_MS = 30_000;

export type Daemon = { readonly url: string; readonly output: () => string; stop(): Promise<Result> };

/** `serve` in the background until its listening line appears; stop() sends SIGTERM and waits for the exit. */
export async function startDaemon(home: Home, env: Record<string, string> = {}): Promise<Daemon> {
  const child = spawnProxy(home, ["serve"], env);
  child.stdin.end();
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  const stderr = new Response(child.stderr).text();
  // A loaded machine can take several seconds to start the instrumented daemon.
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !stdout.includes("listening on")) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${await stderr}`);
    await Bun.sleep(10);
  }
  if (!stdout.includes("listening on")) {
    // Never leave a daemon behind: it would keep running after the test run.
    child.kill("SIGTERM");
    await child.exited;
    throw new Error(`serve did not start within ${START_TIMEOUT_MS} ms: ${stdout}`);
  }
  return {
    url: `http://127.0.0.1:${home.port}`,
    output: () => stdout,
    async stop() {
      child.kill("SIGTERM");
      const [code] = await Promise.all([child.exited, reading]);
      return { code, stdout, stderr: await stderr };
    },
  };
}

export type SignedInDaemon = { readonly home: Home; readonly daemon: Daemon; readonly token: string };

/**
 * A data directory signed in to both providers (browser logins through the fake xdg-open), its token, and `serve`.
 * `prepare` runs on the signed-in directory before the daemon starts (e.g. to place another provider's account file).
 */
export async function startSignedInDaemon(seams: Record<string, string>, yaml?: string, prepare?: (home: Home) => void): Promise<SignedInDaemon> {
  const home = await makeHome(yaml);
  for (const provider of ["antigravity", "claude"]) {
    const login = await runProxy(home, ["login", provider, "--timeout-seconds", "30"], seams);
    if (login.code !== 0) throw new Error(login.stderr);
  }
  prepare?.(home);
  const token = (await runProxy(home, ["token"], seams)).stdout.trim();
  return { home, token, daemon: await startDaemon(home, seams) };
}
