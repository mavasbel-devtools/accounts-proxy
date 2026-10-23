/**
 * The workflow catalogue (plan 2026-10-19-20-04 §17).
 *
 * Every entry is a named, repeatable sequence that a reference client runs inside its isolated profile while the
 * capture proxy records. The catalogue is deterministic data so a version bump can re-run the same workflow and diff
 * the result, instead of an operator improvising prompts.
 *
 * Where a client has no way to be driven without a human, the workflow is marked `unsupported` with the reason
 * measured while building this phase, so the gap is visible in `bun scripts/recon/cli.ts workflows` instead of being
 * silently absent.
 */

import { clientById, type ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";
import type { WorkflowDefinition, WorkflowStep } from "@accounts-proxy/scripts/recon/workflows/types.ts";

/** Prompts kept tiny and fixed: the capture is about the envelope, not about the answer. */
const OK = "Reply with the single word: ok";
const REMEMBER = "Remember the number 41. Reply with the single word: ok";
const ADD_ONE = "Add one to the number I asked you to remember and reply with the number only.";
const LONG = "Write a very long essay about the ocean, at least five thousand words.";
const TOOL =
  "Use the shell tool to run the command printf hello and then reply with exactly the output it produced.";

/** One CLI step. */
function exec(argv: readonly string[], timeoutMs?: number): WorkflowStep {
  const name = `exec:${argv.slice(1).join(" ") || argv[0]}`;
  return {
    name: name.length > 80 ? `${name.slice(0, 77)}...` : name,
    action: { kind: "exec", argv, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  };
}

/** Choices a caller may make for one recording without changing what the workflow is evidence for. */
export type WorkflowOptions = {
  /** The client's own model id (opencode `--model <provider>/<model>`); absent: the profile's default model. */
  readonly model?: string;
};

/** The opencode workflows (`opencode` cell plus its Console/Go control plane). */
function opencodeWorkflows(client: ReconClient, options: WorkflowOptions): WorkflowDefinition[] {
  const bin = client.binary.target;
  const model = options.model === undefined ? [] : ["--model", options.model];
  // Every opencode command talks to a background service by default, which a fresh profile does not have; without
  // `--standalone` the command fails to bind the service port (measured in R2) and no request is made.
  const run = (...args: string[]): string[] => [bin, "run", "--standalone", ...model, ...args];
  return [
    {
      id: "bootstrap",
      client: client.id,
      title: "Control plane: model list",
      purpose: "the model catalogue request the client makes before any conversation",
      // `--standalone` keeps the model list on the client's own private server. Without it the command tries to
      // attach to (or start) a background service on a fixed port and fails inside a fresh profile, which R2 measured.
      steps: [exec([bin, "models", "--standalone"])],
    },
    {
      id: "turn",
      client: client.id,
      title: "Single streamed turn",
      purpose: "the request envelope and SSE framing of one prompt",
      steps: [exec(run(OK))],
    },
    {
      id: "turn-tools",
      client: client.id,
      title: "One turn with a tool call",
      purpose: "tool definitions, the tool_use round trip and the tool_result message",
      steps: [exec(run("--auto", TOOL))],
    },
    {
      id: "multiturn",
      client: client.id,
      title: "Two turns in one session",
      purpose: "how the client replays history and what it omits on the second request",
      steps: [exec(run("--title", "recon multiturn", REMEMBER)), exec(run("--continue", ADD_ONE))],
    },
    {
      id: "abort",
      client: client.id,
      title: "Abort mid-stream",
      purpose: "how the client cancels a stream and what it leaves in the request",
      steps: [exec(run(LONG), 9_000)],
    },
    {
      id: "error",
      client: client.id,
      title: "Unknown model",
      purpose: "the client's own request shape on a model the provider refuses",
      steps: [exec([bin, "run", "--standalone", "--model", "recon/not-a-model", OK])],
    },
  ];
}

/** The Claude Code workflows (`claude` cell). */
function claudeWorkflows(client: ReconClient): WorkflowDefinition[] {
  const bin = client.binary.target;
  return [
    {
      id: "bootstrap",
      client: client.id,
      title: "Process start",
      purpose: "startup traffic before any conversation",
      steps: [],
      unsupported:
        "`--version` makes no request and no other invocation starts without a turn; the start-up traffic (org, model selector, bootstrap, MCP registry: 28 flows measured) is recorded at the head of every `turn` run",
    },
    {
      id: "turn",
      client: client.id,
      title: "Single streamed turn",
      purpose: "the Messages envelope, betas and SSE framing of one print-mode prompt",
      steps: [exec([bin, "-p", OK])],
    },
    {
      id: "turn-tools",
      client: client.id,
      title: "One turn with a tool call",
      purpose: "tool definitions, the tool_use round trip and the tool_result message",
      steps: [exec([bin, "-p", TOOL, "--allowedTools", "Bash"])],
    },
    {
      id: "multiturn",
      client: client.id,
      title: "Two turns in one session",
      purpose: "how the client replays history and what it omits on the second request",
      steps: [exec([bin, "-p", REMEMBER]), exec([bin, "-p", ADD_ONE, "--continue"])],
    },
    {
      id: "abort",
      client: client.id,
      title: "Abort mid-stream",
      purpose: "how the client cancels a stream and what it leaves in the request",
      steps: [exec([bin, "-p", LONG], 9_000)],
    },
    {
      id: "error",
      client: client.id,
      title: "Unknown model",
      purpose: "the client's own request shape when the provider refuses the model",
      steps: [exec([bin, "-p", OK, "--model", "recon-not-a-model"])],
    },
  ];
}

/** The Codex CLI workflows (`openai` cell; Responses over HTTP or WebSocket). */
function codexWorkflows(client: ReconClient): WorkflowDefinition[] {
  const bin = client.binary.target;
  return [
    {
      id: "bootstrap",
      client: client.id,
      title: "Process start",
      purpose: "startup traffic before any conversation (measured: `--version` makes no request)",
      steps: [exec([bin, "--version"])],
    },
    {
      id: "turn",
      client: client.id,
      title: "Single non-interactive turn",
      purpose: "the Responses envelope the client sends, over whichever transport it chooses",
      steps: [exec([bin, "exec", "--skip-git-repo-check", OK])],
    },
    {
      id: "turn-tools",
      client: client.id,
      title: "One turn with a tool call",
      purpose: "tool definitions and the tool-output round trip; the client is already externally sandboxed",
      steps: [exec([bin, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", TOOL])],
    },
    {
      id: "multiturn",
      client: client.id,
      title: "Two turns in one session",
      purpose: "how the client replays history on a resumed session",
      steps: [
        exec([bin, "exec", "--skip-git-repo-check", REMEMBER]),
        exec([bin, "exec", "resume", "--last", ADD_ONE]),
      ],
    },
    {
      id: "abort",
      client: client.id,
      title: "Abort mid-stream",
      purpose: "how the client cancels a stream (WebSocket close vs HTTP abort)",
      steps: [exec([bin, "exec", "--skip-git-repo-check", LONG], 9_000)],
    },
    {
      id: "error",
      client: client.id,
      title: "Unknown model",
      purpose: "the client's own request shape when the provider refuses the model",
      steps: [exec([bin, "exec", "--skip-git-repo-check", "-m", "recon-not-a-model", OK])],
    },
  ];
}

/** The Antigravity IDE workflows (`antigravity` cell, driven through its own window). */
function antigravityWorkflows(client: ReconClient): WorkflowDefinition[] {
  const launch = { kind: "gui-launch", argv: client.defaultCommand } as const;
  return [
    {
      id: "bootstrap",
      client: client.id,
      title: "IDE start-up",
      purpose: "the language server's control-plane calls (auth, onboarding, model list, settings)",
      steps: [
        { name: "gui-launch", action: launch },
        { name: "settle", action: { kind: "wait", ms: 45_000 } },
      ],
    },
    {
      id: "turn",
      client: client.id,
      title: "Single streamed turn",
      purpose: "the Gemini/Cloud Code Assist envelope of one prompt typed into the agent panel",
      // Measured 2026-10-21: the turn is `v1internal:streamGenerateContent`; nothing else counts as having sent it.
      ...(client.turnRequest === undefined ? {} : { expects: client.turnRequest }),
      steps: [
        { name: "gui-launch", action: launch },
        { name: "settle", action: { kind: "wait", ms: 30_000 } },
        // The trust modal and the onboarding carousel both cover the chat panel on every fresh start: onboarding state
        // is not written to the sandboxed profile (`antigravityUnifiedStateSync.*` never appears in `state.vscdb`), so
        // the dismissal is part of every turn rather than a one-off in the login.
        { name: "gui-dismiss", action: { kind: "gui-dismiss" } },
        {
          name: "gui-prompt",
          action: { kind: "gui-prompt", prompt: OK, waitMs: 60_000 },
        },
      ],
    },
    {
      id: "turn-tools",
      client: client.id,
      title: "One turn with a tool call",
      purpose: "function declarations and the functionResponse round trip",
      steps: [],
      unsupported:
        "the IDE exposes no non-interactive tool-approval path; a tool turn needs the approval UI to be clicked",
    },
    {
      id: "multiturn",
      client: client.id,
      title: "Two turns in one session",
      purpose: "trajectory state, labels and history replay inside the language server",
      steps: [],
      unsupported: "a second prompt needs the first turn's UI state; the panel is not scriptable by prompt alone",
    },
    {
      id: "abort",
      client: client.id,
      title: "Abort mid-stream",
      purpose: "how the language server cancels a stream",
      steps: [],
      unsupported: "cancelling needs the panel's stop control, which has no keyboard path",
    },
    {
      id: "error",
      client: client.id,
      title: "Unknown model",
      purpose: "the client's request shape when the model list no longer offers the selection",
      steps: [],
      unsupported: "the model is chosen in the UI; there is no flag to name an unknown one",
    },
  ];
}

const BUILDERS: Record<string, (client: ReconClient, options: WorkflowOptions) => WorkflowDefinition[]> = {
  opencode: opencodeWorkflows,
  claude: claudeWorkflows,
  codex: codexWorkflows,
  antigravity: antigravityWorkflows,
};

/** Clients whose workflows take a `--model` choice. */
const MODEL_CHOICE: ReadonlySet<string> = new Set(["opencode"]);

/** Every workflow of one installed client. Throws when the client is not installed or cannot take an option. */
export function workflowsFor(clientId: string, options: WorkflowOptions = {}): WorkflowDefinition[] {
  const build = BUILDERS[clientId];
  if (build === undefined) throw new Error(`no workflow catalogue for ${clientId}`);
  if (options.model !== undefined && !MODEL_CHOICE.has(clientId)) throw new Error(`${clientId} workflows take no --model`);
  return build(clientById(clientId), options);
}

/** One workflow by client and id. Throws when either is unknown. */
export function workflowById(clientId: string, id: string, options: WorkflowOptions = {}): WorkflowDefinition {
  const found = workflowsFor(clientId, options).find((workflow) => workflow.id === id);
  if (found === undefined) {
    throw new Error(`unknown workflow ${id} for ${clientId}; expected ${workflowsFor(clientId).map((w) => w.id).join(", ")}`);
  }
  return found;
}

/** Every workflow of every installed client, keyed by client id. */
export function allWorkflows(): Record<string, WorkflowDefinition[]> {
  const built: Record<string, WorkflowDefinition[]> = {};
  for (const id of Object.keys(BUILDERS)) {
    try {
      built[id] = workflowsFor(id);
    } catch {
      // Not installed on this machine.
    }
  }
  return built;
}