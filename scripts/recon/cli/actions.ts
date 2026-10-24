// What the recon command line drives: one operation per command, each writing its own report. The commands only parse
// and validate their arguments; the operations (sandbox, capture, parity) sit behind this abstraction.
import type { Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";

/** The reference clients, in the order every listing uses. */
export const RECON_CLIENTS = ["opencode", "antigravity", "claude", "codex"] as const;
export type ReconClientId = (typeof RECON_CLIENTS)[number];

/** A run or workflow that left the sandbox (probe leak) or changed a real client directory (guard). */
export const ISOLATION_EXIT = 3;

export type WorkflowRequest = { readonly client: ReconClientId; readonly workflow: string; readonly timeoutMs?: number; readonly model?: string };
export type ParityRequest = { readonly runDir: string; readonly seqs: readonly number[]; readonly jsonFile?: string };
export type RunRequest = {
  readonly client: ReconClientId;
  readonly mode: "capture" | "login" | "verify";
  readonly loginTarget?: string;
  readonly prompts?: readonly string[];
  readonly fresh: boolean;
  readonly timeoutMs?: number;
  readonly args: readonly string[];
};

export abstract class ReconActions {
  abstract clients(out: Writer): Promise<void>;
  abstract profiles(out: Writer): Promise<void>;
  abstract snapshot(client: ReconClientId, out: Writer): Promise<void>;
  abstract workflows(client: ReconClientId | undefined, out: Writer): Promise<void>;
  /** The exit code: 0, 1 (the run failed or lacks its evidence) or ISOLATION_EXIT. */
  abstract workflow(request: WorkflowRequest, out: Writer): Promise<number>;
  abstract timeline(runDir: string, out: Writer): Promise<void>;
  /** 0 when no request differs, else 1. */
  abstract parity(request: ParityRequest, out: Writer): Promise<number>;
  /** 0 when every client stayed isolated, else ISOLATION_EXIT. */
  abstract isolation(clients: readonly ReconClientId[], out: Writer): Promise<number>;
  abstract reset(client: ReconClientId, out: Writer): Promise<void>;
  /** The exit code: 0, 1 (the run failed) or ISOLATION_EXIT. */
  abstract run(request: RunRequest, out: Writer): Promise<number>;
}
