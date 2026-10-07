// Opens the system browser, fire-and-forget. Windows uses `cmd /c start "" "<url>"` with windowsVerbatimArguments and
// ONE quoted URL token, so `&` in the query cannot be parsed by cmd.exe (opencode-claude-auth AGENTS.md §10).
import { spawn, type SpawnOptions } from "node:child_process";
import { BrowserLauncherPort } from "@inference-router/core/ports/outbound/system.ts";

export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => { once(event: "error", listener: (error: Error) => void): unknown; unref(): void };

export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true };
  if (platform === "darwin") return { command: "open", args: [url], verbatim: false };
  return { command: "xdg-open", args: [url], verbatim: false };
}

export class SystemBrowserLauncher extends BrowserLauncherPort {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawner: Spawner = spawn as unknown as Spawner,
  ) {
    super();
  }

  open(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) return Promise.reject(new Error(`refusing to open a non-http(s) URL: ${url}`));
    const { command, args, verbatim } = browserCommand(this.platform, url);
    return new Promise((resolve, reject) => {
      try {
        const child = this.spawner(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
        child.once("error", reject);
        child.unref();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
}
