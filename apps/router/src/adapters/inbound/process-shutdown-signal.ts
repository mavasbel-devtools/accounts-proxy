// SIGINT (Ctrl-C) or SIGTERM ends `serve`. The handlers are removed once one arrives, so the daemon exits through
// its normal path (which is what keeps e2e coverage, AGENTS.md §5).
import { ShutdownSignal } from "@inference-router/router/adapters/inbound/server.ts";

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type SignalSource = {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

export class ProcessShutdownSignal extends ShutdownSignal {
  constructor(private readonly source: SignalSource = process) {
    super();
  }

  wait(): Promise<string> {
    return new Promise((resolve) => {
      const listeners = SHUTDOWN_SIGNALS.map((name) => {
        const listener = () => {
          for (const [n, l] of listeners) this.source.off(n, l);
          resolve(name);
        };
        return [name, listener] as const;
      });
      for (const [name, listener] of listeners) this.source.once(name, listener);
    });
  }
}
