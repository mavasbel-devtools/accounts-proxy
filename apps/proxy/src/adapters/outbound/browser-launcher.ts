// Opens the system browser, fire-and-forget. Windows uses `cmd /c start "" "<url>"` with windowsVerbatimArguments and
// ONE quoted URL token, so `&` in the query cannot be parsed by cmd.exe (opencode-claude-auth AGENTS.md §10).
import { spawn, type SpawnOptions } from "node:child_process";
import { BrowserLauncherPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export type SpawnedProcess = {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true };
  if (platform === "darwin") return { command: "open", args: [url], verbatim: false };
  return { command: "xdg-open", args: [url], verbatim: false };
}

export class SystemBrowserLauncher extends BrowserLauncherPort {
  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly spawner: Spawner = spawn as unknown as Spawner,
  ) {
    super();
  }

  open(url: string): Promise<void> {
    const { command, args, verbatim } = browserCommand(this.platform, url);
    // Resolved once the opener is running, rejected when it cannot start (e.g. not installed: ENOENT). A synchronous
    // throw of the spawner rejects the promise too (thrown inside the executor).
    return new Promise((resolve, reject) => {
      const child = this.spawner(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
