// Runs the real `accounts-proxy` entry (apps/proxy/src/main/cli.ts) as a child process under the e2e coverage
// preload (AGENTS.md §5): every source file the process loads is instrumented, and the process writes its coverage on
// a normal exit. The child gets its own data directory, the replay seams and a PATH whose first `xdg-open` is the fake
// browser. A daemon is stopped with SIGTERM, which it handles (ProcessShutdownSignal), so it exits normally.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { makeTemporary, temporaryRoot } from "@accounts-proxy/test-support/temporary.ts";

const repo = join(import.meta.dir, "..", "..", "..");
export const ENTRY = join(repo, "apps", "proxy", "src", "main", "cli.ts");
const PRELOAD = join(repo, "scripts", "gate", "e2e-coverage-preload.ts");

export type Home = { readonly dir: string; readonly port: number; readonly browserLog: string; readonly bin: string };

const claimDir = join(temporaryRoot(), "accounts-proxy-claimed-ports");
mkdirSync(claimDir, { recursive: true });

export async function freePort(): Promise<number> {
  while (true) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    try {
      mkdirSync(join(claimDir, String(port)));
      return port;
    } catch {
      await Bun.sleep(5);
    }
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
  const merged: Record<string, string> = { ...env, ACCOUNTS_PROXY_HOME: home.dir, ACCOUNTS_PROXY_E2E_BROWSER_LOG: home.browserLog, XDG_DATA_HOME: join(home.dir, "xdg-data"), PATH: `${home.bin}:${process.env["PATH"] ?? ""}`, ...extra };
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

/** A data directory signed in to both providers (browser logins through the fake xdg-open), its token, and `serve`. */
export async function startSignedInDaemon(seams: Record<string, string>, yaml?: string): Promise<SignedInDaemon> {
  const home = await makeHome(yaml);
  for (const provider of ["antigravity", "claude"]) {
    const login = await runProxy(home, ["login", provider, "--timeout-seconds", "30"], seams);
    if (login.code !== 0) throw new Error(login.stderr);
  }
  const token = (await runProxy(home, ["token"], seams)).stdout.trim();
  return { home, token, daemon: await startDaemon(home, seams) };
}
