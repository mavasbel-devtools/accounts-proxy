// `serve` prints the daemon's log lines and exchange records once it listens (plan 2026-10-27 C1).
import { DaemonConsolePort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import type { ConsoleMirrorPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export class DaemonConsoleService extends DaemonConsolePort {
  constructor(private readonly mirror: ConsoleMirrorPort) {
    super();
  }

  attach(): void {
    this.mirror.start();
  }
}
