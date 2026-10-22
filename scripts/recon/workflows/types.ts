/**
 * Workflow definitions (plan 2026-10-19-20-04 §17).
 *
 * A workflow is a named sequence of steps executed against one reference client inside its isolated profile. The step
 * list is data; the runner in `run.ts` is the only place that spawns anything. A step whose client cannot be driven
 * non-interactively is declared unsupported in the catalogue with the measured reason, never silently skipped.
 */

/** What one step does. */
export type WorkflowAction =
  | {
      /** Run a command inside the sandbox and wait for it to exit. */
      readonly kind: "exec";
      readonly argv: readonly string[];
      readonly timeoutMs?: number;
    }
  | {
      /** Start the GUI client (already windowed inside the private display) and keep it running for later steps. */
      readonly kind: "gui-launch";
      readonly argv: readonly string[];
    }
  | {
      /**
       * Clear a client's blocking start-up dialogs through the DOM: the "trust the authors" modal and an onboarding
       * carousel both cover the chat panel, and neither is dismissed by a flag on Antigravity 1.107.0.
       */
      readonly kind: "gui-dismiss";
    }
  | {
      /** Type a prompt into the running GUI client and submit it. */
      readonly kind: "gui-prompt";
      readonly prompt: string;
      readonly waitMs?: number;
    }
  | {
      /** Let a launched client settle: start-up, language-server boot, or a response still streaming. */
      readonly kind: "wait";
      readonly ms: number;
    };

/** One step of a workflow. */
export interface WorkflowStep {
  readonly name: string;
  readonly action: WorkflowAction;
}

/** A workflow for one client. */
export interface WorkflowDefinition {
  readonly id: string;
  readonly client: string;
  readonly title: string;
  /** What the workflow is evidence for. */
  readonly purpose: string;
  /** Steps to execute, or the measured reason the client cannot run this workflow non-interactively. */
  readonly steps: readonly WorkflowStep[];
  readonly unsupported?: string;
  /**
   * Regex of a request URL the workflow exists to produce. A run without it failed, however many other flows it
   * recorded: measured on Antigravity, a turn whose Send stayed disabled still recorded 350 start-up and telemetry flows.
   */
  readonly expects?: string;
}
