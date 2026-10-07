/** The thinking envelope sent on the claude wire (captured shapes). */
export interface ThinkingSpec {
  readonly type: string
  readonly display: string
  readonly budget_tokens?: number
}

/** Everything the parity envelope needs per model, straight from a real CLI capture. */
export interface ModelEnvelopeSpec {
  readonly betaHeader: string
  readonly thinking: ThinkingSpec
  readonly maxTokens: number
  readonly outputConfig?: { readonly effort: string }
  /** Catalog hints for the host (reasoning-budget math, prompt trimming). */
  readonly limit: { readonly context: number; readonly output: number }
}

/**
 * Capability metadata from the live `GET /v1/models` response (snake_case API
 * keys mapped to camelCase domain fields). Ground truth for limits, thinking
 * types, and effort levels when no CLI capture exists for a model id.
 */
export interface ModelCapabilities {
  readonly thinking: {
    readonly supported: boolean
    readonly types: { readonly enabled: boolean; readonly adaptive: boolean }
  }
  readonly effort: { readonly supported: boolean; readonly levels: readonly string[] }
  readonly batch: boolean
  readonly citations: boolean
  readonly codeExecution: boolean
  readonly imageInput: boolean
  readonly pdfInput: boolean
  readonly structuredOutputs: boolean
  readonly contextManagement: {
    readonly clearToolUses: boolean
    readonly clearThinking: boolean
    readonly compact: boolean
  }
}

/**
 * Per-model beta lists captured from the real claude CLI (2026-08-30, see
 * test/fixtures/model-catalog-envelopes.json). The composition is per-MODEL,
 * not per-family: only opus-4-8 carries `context-1m`; only opus-5/fable-5 add
 * `server-side-fallback`; the 5-series carries `mid-conversation-system`;
 * sonnet-4-5 omits `effort`; opus-4-7 uses effort `xhigh`.
 */
const BETA_FABLE_5 =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,server-side-fallback-2026-07-01,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_OPUS_5 =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_OPUS_4_8 =
  'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_SONNET_5 =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_EFFORT =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_SONNET_4_5 =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const BETA_HAIKU =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'

const ADAPTIVE: ThinkingSpec = { type: 'adaptive', display: 'omitted' }
const ENABLED: ThinkingSpec = { type: 'enabled', display: 'omitted', budget_tokens: 31999 }

/** Captured per-model envelopes (real claude 2.1.251, live 2026-08-30). */
export const MODEL_ENVELOPES: Readonly<Record<string, ModelEnvelopeSpec>> = {
  'claude-opus-5': { betaHeader: BETA_OPUS_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 64_000 } },
  'claude-fable-5': { betaHeader: BETA_FABLE_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 64_000 } },
  'claude-sonnet-5': { betaHeader: BETA_SONNET_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 64_000 } },
  'claude-opus-4-8': { betaHeader: BETA_OPUS_4_8, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'high' }, limit: { context: 1_000_000, output: 64_000 } },
  'claude-opus-4-7': { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'xhigh' }, limit: { context: 200_000, output: 64_000 } },
  'claude-opus-4-6': { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 64_000 } },
  'claude-opus-4-5-20251101': { betaHeader: BETA_EFFORT, thinking: ENABLED, maxTokens: 32_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 32_000 } },
  'claude-sonnet-4-6': { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 32_000, outputConfig: { effort: 'high' }, limit: { context: 200_000, output: 32_000 } },
  'claude-sonnet-4-5-20250929': { betaHeader: BETA_SONNET_4_5, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
  'claude-sonnet-4-5': { betaHeader: BETA_SONNET_4_5, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
  'claude-haiku-4-5-20251001': { betaHeader: BETA_HAIKU, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
}

/** Haiku-safe fallback for unknown model ids (no effort/context-1m betas — never 400s). */
export const FALLBACK_ENVELOPE: ModelEnvelopeSpec = MODEL_ENVELOPES['claude-haiku-4-5-20251001']!

/** Undated aliases the API accepts but the models list never returns. */
const ALIASES: Readonly<Record<string, string>> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
}

/** The captured envelope for a model id. Unknown ids take the haiku-safe fallback. */
export function envelopeFor(model: string | undefined, entry?: CatalogModelEntry): ModelEnvelopeSpec {
  if (!model) return FALLBACK_ENVELOPE
  const spec = MODEL_ENVELOPES[model] ?? MODEL_ENVELOPES[ALIASES[model] ?? '']
  if (spec) return spec
  return entry?.capabilities ? capabilitiesEnvelope(entry) : FALLBACK_ENVELOPE
}

/**
 * API-grounded envelope for a model id with no captured CLI wire: thinking
 * follows the advertised types (adaptive preferred, else enabled with the
 * captured budget), output_config only when adaptive + effort high are
 * supported, max_tokens bounded to the conservative captured maximum, and the
 * beta list stays haiku-safe. A model advertising no thinking type at all
 * keeps the enabled budget shape (the historical fallback behavior).
 */
export function capabilitiesEnvelope(entry: CatalogModelEntry): ModelEnvelopeSpec {
  const c = entry.capabilities
  const adaptive = c?.thinking.types.adaptive ?? false
  const thinking: ThinkingSpec = adaptive ? ADAPTIVE : ENABLED
  const maxTokens = entry.maxTokens > 0 ? Math.min(entry.maxTokens, 32_000) : 32_000
  const effortSupported = adaptive && (c?.effort.levels.includes('high') ?? false)
  return {
    betaHeader: FALLBACK_ENVELOPE.betaHeader,
    thinking,
    maxTokens,
    ...(effortSupported ? { outputConfig: { effort: 'high' } } : {}),
    limit: {
      context: entry.maxInputTokens > 0 ? entry.maxInputTokens : FALLBACK_ENVELOPE.limit.context,
      output: entry.maxTokens > 0 ? entry.maxTokens : FALLBACK_ENVELOPE.limit.output,
    },
  }
}

/** One entry of the Anthropic `/v1/models` catalog (full live metadata). */
export interface CatalogModelEntry {
  readonly id: string
  readonly displayName: string
  readonly createdAt: string
  readonly maxInputTokens: number
  readonly maxTokens: number
  readonly capabilities?: ModelCapabilities
}

const CM_ALL: ModelCapabilities['contextManagement'] = { clearToolUses: true, clearThinking: true, compact: true }
const CM_NO_COMPACT: ModelCapabilities['contextManagement'] = { clearToolUses: true, clearThinking: true, compact: false }
const THINKING_ADAPTIVE_ONLY: ModelCapabilities['thinking'] = {
  supported: true,
  types: { enabled: false, adaptive: true },
}
const THINKING_BOTH: ModelCapabilities['thinking'] = {
  supported: true,
  types: { enabled: true, adaptive: true },
}
const THINKING_ENABLED_ONLY: ModelCapabilities['thinking'] = {
  supported: true,
  types: { enabled: true, adaptive: false },
}
const EFFORT_ALL: ModelCapabilities['effort'] = { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] }
const EFFORT_NO_XHIGH: ModelCapabilities['effort'] = { supported: true, levels: ['low', 'medium', 'high', 'max'] }
const EFFORT_NO_MAX: ModelCapabilities['effort'] = { supported: true, levels: ['low', 'medium', 'high'] }
const EFFORT_NONE: ModelCapabilities['effort'] = { supported: false, levels: [] }
const BASE_CAPS: Omit<ModelCapabilities, 'thinking' | 'effort' | 'contextManagement' | 'codeExecution'> = {
  batch: true,
  citations: true,
  imageInput: true,
  pdfInput: true,
  structuredOutputs: true,
}
const capsAdaptiveFull = (): ModelCapabilities => ({
  ...BASE_CAPS,
  thinking: THINKING_ADAPTIVE_ONLY,
  effort: EFFORT_ALL,
  codeExecution: true,
  contextManagement: CM_ALL,
})
const caps46 = (): ModelCapabilities => ({
  ...BASE_CAPS,
  thinking: THINKING_BOTH,
  effort: EFFORT_NO_XHIGH,
  codeExecution: true,
  contextManagement: CM_ALL,
})

/**
 * Probe-validated static minimum (live `GET /v1/models` + real-CLI wires,
 * 2026-09-01; fixture test/fixtures/catalog-api-response.json). Fallback when
 * the live fetch fails and no cache exists.
 */
export const STATIC_CATALOG: readonly CatalogModelEntry[] = [
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', createdAt: '2026-07-24T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', createdAt: '2026-06-29T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', createdAt: '2026-06-07T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', createdAt: '2026-05-28T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', createdAt: '2026-04-14T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', createdAt: '2026-02-17T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: caps46() },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', createdAt: '2026-02-04T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: caps46() },
  { id: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', createdAt: '2025-11-24T00:00:00Z', maxInputTokens: 200_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NO_MAX, codeExecution: true, contextManagement: CM_NO_COMPACT } },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', createdAt: '2025-10-15T00:00:00Z', maxInputTokens: 200_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NONE, codeExecution: false, contextManagement: CM_NO_COMPACT } },
  { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', createdAt: '2025-09-29T00:00:00Z', maxInputTokens: 1_000_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NONE, codeExecution: true, contextManagement: CM_NO_COMPACT } },
]
