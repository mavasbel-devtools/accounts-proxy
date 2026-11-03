import type { InputModality, ModelDescriptor } from '@antigravity/domain/entities/ModelDescriptor.ts'

type RawModel = {
  displayName?: string
  maxTokens?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  supportsVideo?: boolean
  supportedMimeTypes?: unknown
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

const MODALITY_ORDER: readonly InputModality[] = ['text', 'image', 'audio', 'video', 'pdf']

/**
 * Every input kind the catalog says the model accepts: text always; image when
 * `supportsImages`; audio when any `audio/*` MIME type is listed; video when
 * `supportsVideo`; pdf when `application/pdf` is listed. Pure catalog truth —
 * what a given host can actually deliver is that host adapter's intersection
 * (see `deliverableInputModalities`).
 */
export function catalogInputModalities(m: Pick<ModelDescriptor, 'supportsImages' | 'supportsVideo' | 'supportedMimeTypes'>): InputModality[] {
  const kinds = new Set<InputModality>(['text'])
  if (m.supportsImages) kinds.add('image')
  if (m.supportedMimeTypes.some((t) => t.startsWith('audio/'))) kinds.add('audio')
  if (m.supportsVideo) kinds.add('video')
  if (m.supportedMimeTypes.includes('application/pdf')) kinds.add('pdf')
  return MODALITY_ORDER.filter((k) => kinds.has(k))
}

/** The catalog's input kinds restricted to what a host's request route can carry, in a stable order. */
export function deliverableInputModalities(
  m: Pick<ModelDescriptor, 'supportsImages' | 'supportsVideo' | 'supportedMimeTypes'>,
  hostDelivers: ReadonlySet<InputModality>,
): InputModality[] {
  return catalogInputModalities(m).filter((k) => hostDelivers.has(k))
}

function trueKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
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
      supportedMimeTypes: trueKeys(m.supportedMimeTypes),
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
