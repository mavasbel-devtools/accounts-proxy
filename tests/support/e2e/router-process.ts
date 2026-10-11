// Runs the real `inference-router` entry (apps/router/src/main/cli.ts) as a child process under the e2e coverage
// preload (AGENTS.md §5): every source file the process loads is instrumented, and the process writes its coverage on
// a normal exit. The child gets its own data directory, the replay seams and a PATH whose first `xdg-open` is the fake
// browser. A daemon is stopped with SIGTERM, which it handles (ProcessShutdownSignal), so it exits normally.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { makeTemporary } from "@inference-router/test-support/temporary.ts";

const repo = join(import.meta.dir, "..", "..", "..");
export const ENTRY = join(repo, "apps", "router", "src", "main", "cli.ts");
const PRELOAD = join(repo, "scripts", "gate", "e2e-coverage-preload.ts");

export type Home = { readonly dir: string; readonly port: number; readonly browserLog: string; readonly bin: string };

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export const BOTH_PROVIDERS = "providers:\n  claude: {enabled: true, acknowledgeTermsRisk: true}\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n";

/** A fresh data directory with router.yaml (a free port unless given) and the fake browser on a private bin dir. */
export async function makeHome(yaml: string = BOTH_PROVIDERS, port?: number): Promise<Home> {
  const dir = makeTemporary("router-e2e");
  const chosen = port ?? (await freePort());
  writeFileSync(join(dir, "router.yaml"), `port: ${chosen}\n${yaml}`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const opener = join(bin, "xdg-open");
  writeFileSync(opener, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-browser.ts")}" "$1"\n`);
  chmodSync(opener, 0o755);
  return { dir, port: chosen, browserLog: join(dir, "browser.log"), bin };
}

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

function environment(home: Home, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("INFERENCE_ROUTER_TEST_UPSTREAM_")) env[k] = v;
  return { ...env, INFERENCE_ROUTER_HOME: home.dir, INFERENCE_ROUTER_E2E_BROWSER_LOG: home.browserLog, PATH: `${home.bin}:${process.env["PATH"] ?? ""}`, ...extra };
}

function spawnRouter(home: Home, argv: readonly string[], env: Record<string, string>) {
  return Bun.spawn([process.execPath, "--preload", PRELOAD, ENTRY, ...argv], { cwd: repo, env: environment(home, env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** One CLI command to completion; `input` is written to stdin when given (the paste-code prompt). */
export async function runRouter(home: Home, argv: readonly string[], env: Record<string, string> = {}, input?: (stdout: () => string) => Promise<string>): Promise<Result> {
  const child = spawnRouter(home, argv, env);
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  if (input !== undefined) child.stdin.write(await input(() => stdout));
  child.stdin.end();
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), reading]);
  return { code, stdout, stderr };
}

export type Daemon = { readonly url: string; readonly output: () => string; stop(): Promise<Result> };

/** `serve` in the background until its listening line appears; stop() sends SIGTERM and waits for the exit. */
export async function startDaemon(home: Home, env: Record<string, string> = {}): Promise<Daemon> {
  const child = spawnRouter(home, ["serve"], env);
  child.stdin.end();
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  const stderr = new Response(child.stderr).text();
  for (let i = 0; i < 500 && !stdout.includes("listening on"); i++) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${await stderr}`);
    await Bun.sleep(10);
  }
  if (!stdout.includes("listening on")) throw new Error(`serve did not start: ${stdout}`);
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
