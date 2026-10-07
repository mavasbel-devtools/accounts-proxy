import type { ModelDescriptor } from '@antigravity/domain/entities/ModelDescriptor.ts'

type RawModel = {
  displayName?: string
  maxTokens?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  supportsVideo?: boolean
  thinkingBudget?: number
  minThinkingBudget?: number
  recommended?: boolean
  tagTitle?: string
  model?: string
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
}

/**
 * Model ids the catalog marks as NOT chat-capable, with the capture-verified
 * reasons: `tabModelIds` are tab-completion models (the IDE never chats with
 * them — they 400 on streamGenerateContent) and `deprecatedModelIds` are
 * deprecated upstream (server rejects generation with 400 INVALID_ARGUMENT).
 */
export interface ExcludedModel {
  wireId: string
  reason: 'tab-completion' | 'deprecated'
  replacement?: string
}

/** Extracts non-chat model ids and their exclusion reasons from the raw catalog. */
export function excludedModelIds(raw: Record<string, unknown>): ExcludedModel[] {
  const out: ExcludedModel[] = []
  const tab = raw['tabModelIds']
  if (Array.isArray(tab)) {
    for (const id of tab) if (typeof id === 'string') out.push({ wireId: id, reason: 'tab-completion' })
  }
  const deprecated = raw['deprecatedModelIds']
  if (deprecated && typeof deprecated === 'object' && !Array.isArray(deprecated)) {
    for (const [id, meta] of Object.entries(deprecated as Record<string, unknown>)) {
      const replacement =
        meta && typeof meta === 'object' && typeof (meta as { newModelId?: unknown }).newModelId === 'string'
          ? (meta as { newModelId: string }).newModelId
          : undefined
      out.push({ wireId: id, reason: 'deprecated', ...(replacement !== undefined ? { replacement } : {}) })
    }
  }
  return out
}

/**
 * The working-set ceiling the real Antigravity IDE enforces on its own
 * conversations: its catalog ships `CASCADE_USE_EXPERIMENT_CHECKPOINTER` with
 * `max_token_limit: 80000` (trigger `token_threshold: 50000`, summariser
 * `checkpoint_model: MODEL_PLACEHOLDER_M50` = gemini-3.1-flash-lite), so a cheap
 * model compresses the history and the expensive model never sees more than
 * ~80k. Measured consequence across 151 captured IDE responses: every request
 * carries 21,564-29,215 prompt tokens, whatever the model.
 */
export const IDE_WORKING_SET_CONTEXT_CAP = 80_000

/**
 * The context window we ADVERTISE to the host — the catalog window clamped to
 * the IDE's working-set ceiling. This is a policy about what we advertise, not
 * a claim about the model: `ModelDescriptor.maxTokens` stays truthful.
 *
 * Why clamp (measured 2026-10-04): quota is billed per PROMPT token
 * (2.70e-8 - 3.75e-8 of a 5h bucket per token, so ~27-35M tokens per 5h
 * window), and opencode compacts relative to the window it is told. Advertising
 * the catalog value verbatim (1,048,576 gemini / 1,000,000 claude) meant
 * conversations grew until they rode that ceiling: 8,305 real requests averaged
 * 218,633 prompt tokens, p90 452k, max 924,209 (= 88% of 1,048,576) - 8-9x the
 * IDE's per-request cost, which is why a shared 5h allowance vanished in ~60-150
 * requests.
 *
 * The clamp is also below EVERY model's real window (the smallest is gpt-oss at
 * 131,072), so a conversation grown on a 1M-window model can still be switched
 * into gpt-oss instead of hard-400ing with
 * "The input (N tokens) is longer than the model's context length (131072 tokens)".
 */
export function advertisedContextWindow(m: Pick<ModelDescriptor, 'maxTokens'>): number {
  return Math.min(m.maxTokens, IDE_WORKING_SET_CONTEXT_CAP)
}

/**
 * Per-model default thinking request (catalog-exact, decided 2026-09-26):
 * the wire `thinkingConfig.thinkingBudget` equals the catalog's advertised
 * `thinkingBudget` VERBATIM for every model — exactly what the real IDE sends
 * (22/22 captured envelopes across 3 eras match the catalog row: gpt-oss 8192,
 * claude 1024, gemini 3.8-medium 4000 / 3.6-low 1000 / 3.1-pro-low 1001 /
 * pro-agent 10001 / high+tiered -1). Replaces the 2026-08-28 option-B policy
 * (gemini → -1 dynamic) per the user's strict-parity decision; a fixed budget
 * may occasionally yield 0 thought chars on Gemini (measured), matching the IDE.
 * - Models without thinking support or an advertised budget → undefined (no
 *   thinkingConfig injected; tab/image/checkpoint models).
 */
export function thinkingDefaultFor(m: ModelDescriptor): number | undefined {
  if (!m.supportsThinking || m.thinkingBudget === undefined) return undefined
  return m.thinkingBudget
}

/**
 * Maps the captured `fetchAvailableModels` response into domain descriptors.
 * Excludes models the catalog itself marks non-chat (tab-completion,
 * deprecated). When multiple distinct wireIds share one display name, later
 * ones get a ` (wireId)` suffix so opencode's picker stays unambiguous.
 */
export function toModelDescriptors(raw: Record<string, unknown>): ModelDescriptor[] {
  const models = (raw['models'] ?? {}) as Record<string, RawModel>
  const excluded = new Set(excludedModelIds(raw).map((e) => e.wireId))
  const entries = Object.entries(models).filter(([wireId]) => !excluded.has(wireId))
  const nameCounts = new Map<string, number>()
  for (const [, m] of entries) {
    const name = m.displayName ?? ''
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return entries.map(([wireId, m]) => {
    const baseName = m.displayName ?? wireId
    let displayName = baseName
    if ((nameCounts.get(baseName) ?? 0) > 1) {
      const n = (seen.get(baseName) ?? 0) + 1
      seen.set(baseName, n)
      displayName = `${baseName} (${wireId})`
    }
    return {
      wireId,
      displayName,
      maxTokens: m.maxTokens ?? 0,
      maxOutputTokens: m.maxOutputTokens ?? 0,
      supportsImages: m.supportsImages === true,
      supportsThinking: m.supportsThinking === true,
      supportsVideo: m.supportsVideo === true,
      ...(m.thinkingBudget !== undefined ? { thinkingBudget: m.thinkingBudget } : {}),
      ...(m.minThinkingBudget !== undefined ? { minThinkingBudget: m.minThinkingBudget } : {}),
      recommended: m.recommended === true,
      ...(m.tagTitle !== undefined ? { tagTitle: m.tagTitle } : {}),
      enumPlaceholder: m.model ?? '',
      ...(m.quotaInfo?.remainingFraction !== undefined && m.quotaInfo.resetTime
        ? {
            quota: {
              remainingFraction: m.quotaInfo.remainingFraction,
              resetTime: m.quotaInfo.resetTime,
            },
          }
        : {}),
    }
  })
}
