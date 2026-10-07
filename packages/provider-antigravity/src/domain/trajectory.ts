// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/TrajectoryStateService.ts (blob e01e9aac).
// Capture-verified IDE trajectory envelope (2026-08-25, 2026-09-26): 5-segment requestId, per-install int64 sessionId
// (exact decimal string; never Number()), ordered labels, step cadence 2,5,7,9,…, last_execution_id rotation.
// Pure: randomness and time arrive as functions; the persisted sessionId is supplied by the caller.
import type { ChatMessage } from "@inference-router/provider-antigravity/domain/generate.ts";

export type ModelFamily = "gemini" | "claude" | "other";

/** Exact captured key order: last_execution_id (when present) first. */
export type TrajectoryLabels = {
  readonly last_execution_id?: string;
  readonly last_step_index: string;
  readonly model_enum: string;
  readonly trajectory_id: string;
  readonly used_claude: string;
  readonly used_claude_conservative: string;
  readonly used_non_gemini_model: string;
};

export type TrajectorySnapshot = { readonly requestId: string; readonly sessionId: string; readonly labels: TrajectoryLabels };

/** Signed 64-bit device id: FNV-1a 64 of a fresh uuid, as the exact decimal string of the signed value. */
export function mintSessionId(uuid: () => string): string {
  const seed = uuid();
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < seed.length; i++) {
    h ^= BigInt(seed.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return BigInt.asIntN(64, h).toString();
}

/** A persisted session id is valid only as a signed int64 decimal string (proto int64 → JSON string). */
export function isSessionId(value: unknown): value is string {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) return false;
  const n = BigInt(value);
  return n >= -(2n ** 63n) && n < 2n ** 63n;
}

function firstUserText(messages: readonly ChatMessage[]): string {
  for (const m of messages) if (m.role === "user") return m.text.trim();
  return "";
}

const signatureOf = (messages: readonly ChatMessage[]): string => `${firstUserText(messages)}|${messages.length}`;

function countOf(sig: string): number {
  const n = Number(sig.split("|")[1]);
  return Number.isFinite(n) ? n : 0;
}

/** Same trajectory iff the same first user turn AND the list did not shrink. */
export function isContinuation(prev: string | undefined, messages: readonly ChatMessage[]): boolean {
  if (prev === undefined || messages.length === 0) return false;
  return prev.startsWith(`${firstUserText(messages)}|`) && messages.length >= countOf(prev);
}

export function defaultFamilyOf(wireId: string): ModelFamily {
  const id = wireId.toLowerCase();
  if (id.startsWith("gemini")) return "gemini";
  if (id.startsWith("claude")) return "claude";
  return "other";
}

type Conversation = {
  readonly trajectoryUuid: string;
  stepCounter: number;
  completedStreams: number;
  usedClaude: boolean;
  usedClaudeConservative: boolean;
  usedNonGeminiModel: boolean;
  lastExecutionId: string | undefined;
  hasEmittedFirst: boolean;
  lastSignature: string | undefined;
};

export type TrajectoryDeps = {
  /** requestId segment 2: one uuid per process launch. */
  readonly sessionUuid: string;
  /** Persisted per-install int64 decimal string. */
  readonly sessionId: string;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly familyOf?: (wireId: string) => ModelFamily;
};

export class TrajectoryState {
  private conversation: Conversation | undefined;
  private readonly familyOf: (wireId: string) => ModelFamily;

  constructor(private readonly deps: TrajectoryDeps) {
    this.familyOf = deps.familyOf ?? defaultFamilyOf;
  }

  begin(modelWireId: string, modelEnum: string, messages: readonly ChatMessage[]): TrajectorySnapshot {
    const family = this.familyOf(modelWireId);
    const sig = signatureOf(messages);
    if (this.conversation === undefined || !isContinuation(this.conversation.lastSignature, messages)) {
      this.conversation = {
        trajectoryUuid: this.deps.uuid(),
        stepCounter: 2,
        completedStreams: 0,
        usedClaude: false,
        usedClaudeConservative: false,
        usedNonGeminiModel: false,
        lastExecutionId: undefined,
        hasEmittedFirst: false,
        lastSignature: sig,
      };
    }
    const conv = this.conversation;
    conv.lastSignature = sig;
    if (family === "claude") {
      conv.usedClaude = true;
      conv.usedClaudeConservative = true;
      conv.usedNonGeminiModel = true;
    } else if (family === "other") {
      conv.usedNonGeminiModel = true;
    }
    const isToolContinuation = messages.length > 0 && messages[messages.length - 1]!.role === "tool";
    if (conv.hasEmittedFirst) {
      if (!isToolContinuation) conv.lastExecutionId = this.deps.uuid();
    } else {
      conv.hasEmittedFirst = true;
      conv.lastExecutionId = undefined;
    }
    const labels: TrajectoryLabels = {
      last_step_index: String(conv.stepCounter),
      model_enum: modelEnum,
      trajectory_id: conv.trajectoryUuid,
      used_claude: String(conv.usedClaude),
      used_claude_conservative: String(conv.usedClaudeConservative),
      used_non_gemini_model: String(conv.usedNonGeminiModel),
    };
    return {
      requestId: `agent/${this.deps.sessionUuid}/${this.deps.now()}/${conv.trajectoryUuid}/${conv.stepCounter + 1}`,
      sessionId: this.deps.sessionId,
      labels: conv.lastExecutionId !== undefined ? { last_execution_id: conv.lastExecutionId, ...labels } : labels,
    };
  }

  /** After a completed stream: step counter +3 the first time, then +2. */
  complete(): void {
    if (this.conversation === undefined) return;
    this.conversation.stepCounter += this.conversation.completedStreams === 0 ? 3 : 2;
    this.conversation.completedStreams += 1;
  }
}
