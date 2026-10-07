import type { ChatMessage } from '@antigravity/domain/ports/inbound/index.ts'
import type { ClockPort, DeviceIdentityStorePort, RandomPort } from '@antigravity/domain/ports/outbound/index.ts'

/** Wire model family used to drive the sticky trajectory flags. */
export type ModelFamily = 'gemini' | 'claude' | 'other'

/**
 * The label set the real IDE carries on every agent stream call, in EXACT
 * captured key order (2026-09-26 and 2026-08-25): `last_execution_id` first
 * when present, then last_step_index, model_enum, trajectory_id, used_*.
 */
export interface TrajectoryLabels {
  readonly last_execution_id?: string
  readonly last_step_index: string
  readonly model_enum: string
  readonly trajectory_id: string
  readonly used_claude: string
  readonly used_claude_conservative: string
  readonly used_non_gemini_model: string
}

/**
 * A full snapshot of the trajectory state for ONE outgoing stream request:
 * the 5-segment requestId, the per-install sessionId and the ordered labels.
 */
export interface TrajectorySnapshot {
  readonly requestId: string
  /** Per-install signed 64-bit device constant as its exact decimal STRING (proto int64 → JSON string, TYPE_STRING). */
  readonly sessionId: string
  /** Ordered labels; model_enum comes from the resolved catalog. */
  readonly labels: TrajectoryLabels
}

interface ConversationState {
  /** trajectoryUuid — per-conversation, becomes requestId segment 4 and labels.trajectory_id. */
  readonly trajectoryUuid: string
  /** Next step index to emit; advances +3 first, then +2 per completed stream (measured cadence). */
  stepCounter: number
  completedStreams: number
  usedClaude: boolean
  usedClaudeConservative: boolean
  usedNonGeminiModel: boolean
  /** Per-execution uuid; reused across a tool-loop, fresh per user turn. */
  lastExecutionId: string | undefined
  /** First stream request of the trajectory carries NO last_execution_id. */
  hasEmittedFirst: boolean
  /** Fingerprint of the message list this conversation last saw (rotation input). */
  lastSignature: string | undefined
}

export interface TrajectoryDeps {
  random: RandomPort
  clock: ClockPort
  identity: DeviceIdentityStorePort
  /** Model-family classifier; defaults to wire-id prefix matching. */
  familyOf?: (modelWireId: string) => ModelFamily
}

/** Signed 64-bit device id, persisted per install. Derived (FNV-1a 64) from a random
 *  seed so it stays deterministic per install while never parsing hex out of an
 *  assumed-valid uuid string. Returns the EXACT decimal string of the signed int64
 *  (no Number round-trip — values exceed Number.MAX_SAFE_INTEGER and a double would
 *  lose digits; the wire requires the exact decimal string, proto int64 → JSON string). */
export function mintSessionId(random: RandomPort): string {
  const seed = random.uuid()
  // FNV-1a 64-bit
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < seed.length; i++) {
    h ^= BigInt(seed.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return BigInt.asIntN(64, h).toString()
}

/** Pure rotation heuristic: the same trajectory iff the same first user turn AND the list grew. */
export function isContinuation(prev: string | undefined, messages: readonly ChatMessage[]): boolean {
  if (prev === undefined || messages.length === 0) return false
  const first = firstUserText(messages)
  return prev.startsWith(`${first}|`) && messages.length >= countOf(prev)
}

function firstUserText(messages: readonly ChatMessage[]): string {
  for (const m of messages) if (m.role === 'user') return m.text.trim()
  return ''
}

function signature(messages: readonly ChatMessage[]): string {
  return `${firstUserText(messages)}|${messages.length}`
}

function countOf(sig: string): number {
  const n = Number(sig.split('|')[1])
  return Number.isFinite(n) ? n : 0
}

export function defaultFamilyOf(wireId: string): ModelFamily {
  const id = wireId.toLowerCase()
  if (id.startsWith('gemini')) return 'gemini'
  if (id.startsWith('claude')) return 'claude'
  return 'other'
}

/**
 * Tracks the conversation/trajectory/execution identity the real Antigravity
 * IDE carries on streamGenerateContent, capture-verified across 2026-08-25
 * (14 agent blips, 4 models) and 2026-09-26 (4 agent blips). One instance per
 * plugin process:
 *
 * - sessionUuid: minted once per launch (requestId segment 2).
 * - sessionId:    per-install signed int64, persisted next to the pool file.
 * - trajectoryUuid: per-conversation; rotates on a non-continuation message list.
 * - step counter:   per-conversation, +3 then +2 per completed stream
 *                   (measured cadence 2,5,7,9,… in both captures).
 * - last_execution_id: per-execution uuid — first request of a trajectory omits
 *                   it; a tool-loop continues the same one; a new user turn
 *                   rotates it (capture-proven: ccf62beb reused on /16 /18 /21).
 */
export class TrajectoryStateService {
  private readonly sessionUuid: string
  private readonly sessionId: string
  private readonly random: RandomPort
  private readonly clock: ClockPort
  private readonly familyOf: (modelWireId: string) => ModelFamily
  private conversation: ConversationState | undefined

  constructor(deps: TrajectoryDeps) {
    this.random = deps.random
    this.clock = deps.clock
    this.familyOf = deps.familyOf ?? defaultFamilyOf
    this.sessionUuid = deps.random.uuid()
    const stored = deps.identity.load()
    this.sessionId = stored ?? mintSessionId(deps.random)
    if (stored === undefined) deps.identity.save(this.sessionId)
  }

  get persistedSessionId(): string {
    return this.sessionId
  }

  /** Begins one outgoing stream request, advancing trajectory state. */
  begin(modelWireId: string, modelEnum: string, messages: readonly ChatMessage[]): TrajectorySnapshot {
    const family = this.familyOf(modelWireId)
    const sig = signature(messages)

    if (this.conversation === undefined || !isContinuation(this.conversation.lastSignature, messages)) {
      this.conversation = {
        trajectoryUuid: this.random.uuid(),
        stepCounter: 2,
        completedStreams: 0,
        usedClaude: false,
        usedClaudeConservative: false,
        usedNonGeminiModel: false,
        lastExecutionId: undefined,
        hasEmittedFirst: false,
        lastSignature: sig,
      }
    }

    const conv = this.conversation
    conv.lastSignature = sig

    // Sticky per-trajectory flags: once a family ran in this conversation it stays set.
    if (family === 'claude') {
      conv.usedClaude = true
      conv.usedClaudeConservative = true
      conv.usedNonGeminiModel = true
    } else if (family === 'other') {
      conv.usedNonGeminiModel = true
    }

    // last_execution_id: new user turn → fresh execution; tool-loop → same execution.
    // First request of the trajectory never carries it (verified both captures).
    const isToolContinuation = messages.length > 0 && messages[messages.length - 1]!.role === 'tool'
    if (conv.hasEmittedFirst) {
      if (!isToolContinuation) conv.lastExecutionId = this.random.uuid()
    } else {
      conv.hasEmittedFirst = true
      conv.lastExecutionId = undefined
    }

    const epochMs = this.clock.now()
    const labels: TrajectoryLabels = {
      last_step_index: String(conv.stepCounter),
      model_enum: modelEnum,
      trajectory_id: conv.trajectoryUuid,
      used_claude: String(conv.usedClaude),
      used_claude_conservative: String(conv.usedClaudeConservative),
      used_non_gemini_model: String(conv.usedNonGeminiModel),
    }
    const ordered = conv.lastExecutionId !== undefined ? { last_execution_id: conv.lastExecutionId, ...labels } : labels
    return {
      requestId: `agent/${this.sessionUuid}/${epochMs}/${conv.trajectoryUuid}/${conv.stepCounter + 1}`,
      sessionId: this.sessionId,
      labels: ordered,
    }
  }

  /** Call after a completed stream request: advances the step counter (first +3, then +2 — the
   *  measured cadence in both 2026-08-25 and 2026-09-26 captures: 2,5,7,9,11,…). */
  complete(): void {
    if (this.conversation === undefined) return
    this.conversation.stepCounter += this.conversation.completedStreams === 0 ? 3 : 2
    this.conversation.completedStreams += 1
  }
}