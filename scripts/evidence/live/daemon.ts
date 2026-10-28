// The production daemon (`runCli(["serve"])` from the composition root) inside a live-evidence script's process, so its
// upstream traffic goes through the harness's recording transport. Shared by the live matrix (l1) and the media probe
// (m1): start() prints the proxy token into the redactor, serves on the configured port and returns the base URL;
// stop() asks the daemon to shut down through its normal exit path and returns its exit code and output.
import { join } from "node:path";
import { SystemBrowserLauncher } from "@accounts-proxy/proxy/adapters/outbound/browser-launcher.ts";
import { opencodeDataDir } from "@accounts-proxy/proxy/adapters/outbound/opencode-auth-file.ts";
import { ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";
import { LOOPBACK_HOST, PRODUCTION_LOCK, runCli, type ContainerOptions } from "@accounts-proxy/proxy/composition/container.ts";
import { sleep, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";

export class ManualShutdown extends ShutdownSignal {
  private release: (name: string) => void = () => undefined;
  private readonly asked = new Promise<string>((resolve) => (this.release = resolve));
  wait(): Promise<string> {
    return this.asked;
  }
  stop(): void {
    this.release("SIGTERM");
  }
}

export function daemonOptions(live: Live, out: (text: string) => void, shutdown: ShutdownSignal): ContainerOptions {
  return {
    home: live.home,
    accounts: live.accounts,
    opencodeData: opencodeDataDir(process.env),
    entry: [process.execPath, join(import.meta.dir, "..", "..", "..", "apps", "proxy", "src", "main", "cli.ts")],
    out,
    err: out,
    stdin: process.stdin,
    stdout: process.stdout,
    seams: {},
    transport: live.recorder,
    browser: new SystemBrowserLauncher(process.platform),
    shutdown,
    listenHost: LOOPBACK_HOST,
    lock: PRODUCTION_LOCK,
  };
}

export type RunningDaemon = {
  readonly base: string;
  readonly token: string;
  stop(): Promise<{ readonly code: number; readonly output: string }>;
};

export async function startDaemon(live: Live): Promise<RunningDaemon> {
  // The gateway API keys are only in the authorization header (redacted by name); they are also secrets for the scan.
  for (const gateway of live.gateways) live.redactor.add(`${gateway.spec.provider}_key`, await gateway.session.optionalKey());
  let tokenText = "";
  await runCli(["token"], daemonOptions(live, (t) => void (tokenText += t), new ManualShutdown()));
  const token = tokenText.trim();
  live.redactor.add("proxy_token", token);

  let output = "";
  const shutdown = new ManualShutdown();
  const serving = runCli(["serve"], daemonOptions(live, (t) => void (output += t), shutdown));
  for (let i = 0; i < 3000 && !output.includes("listening on"); i++) await sleep(10);
  const base = /listening on (http:\/\/\S+)/.exec(output)?.[1];
  if (base === undefined) throw new Error(`serve did not start: ${output}`);
  return {
    base,
    token,
    async stop() {
      shutdown.stop();
      const code = await serving;
      return { code, output };
    },
  };
}
