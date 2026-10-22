// Port of opencode-claude-auth @ 6292741 src/domain/services/ModelEnvelope.ts (git blob ef95776e).
// Data is byte-identical to the source; only formatting follows this repository's style.

import { BETA_OPUS_5_5 } from "@accounts-proxy/provider-claude/domain/client-profile.ts";

export type ThinkingSpec = { readonly type: string; readonly display: string; readonly budget_tokens?: number };

export type ModelEnvelopeSpec = {
  readonly betaHeader: string;
  readonly thinking: ThinkingSpec;
  readonly maxTokens: number;
  readonly outputConfig?: { readonly effort: string };
  readonly limit: { readonly context: number; readonly output: number };
};

/** Capability metadata of the live `GET /v1/models` response (snake_case API keys mapped to camelCase). */
export type ModelCapabilities = {
  readonly thinking: { readonly supported: boolean; readonly types: { readonly enabled: boolean; readonly adaptive: boolean } };
  readonly effort: { readonly supported: boolean; readonly levels: readonly string[] };
  readonly batch: boolean;
  readonly citations: boolean;
  readonly codeExecution: boolean;
  readonly imageInput: boolean;
  readonly pdfInput: boolean;
  readonly structuredOutputs: boolean;
  readonly contextManagement: { readonly clearToolUses: boolean; readonly clearThinking: boolean; readonly compact: boolean };
};

export type CatalogModelEntry = {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly maxInputTokens: number;
  readonly maxTokens: number;
  readonly capabilities?: ModelCapabilities;
};

const BETA_FABLE_5 =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,server-side-fallback-2026-07-01,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_OPUS_5 =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_OPUS_4_8 =
  "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_SONNET_5 =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_EFFORT =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_SONNET_4_5 =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
const BETA_HAIKU =
  "oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";

const ADAPTIVE: ThinkingSpec = { type: "adaptive", display: "omitted" };
const ENABLED: ThinkingSpec = { type: "enabled", display: "omitted", budget_tokens: 31999 };

export const MODEL_ENVELOPES: Readonly<Record<string, ModelEnvelopeSpec>> = {
  "claude-opus-5-5": { betaHeader: BETA_OPUS_5_5, thinking: ADAPTIVE, maxTokens: 128_000, outputConfig: { effort: "high" }, limit: { context: 1_000_000, output: 128_000 } },
  "claude-sonnet-5-5": { betaHeader: BETA_OPUS_5_5, thinking: ADAPTIVE, maxTokens: 128_000, outputConfig: { effort: "high" }, limit: { context: 1_000_000, output: 128_000 } },
  "claude-haiku-5-5": { betaHeader: BETA_OPUS_5_5, thinking: ADAPTIVE, maxTokens: 128_000, outputConfig: { effort: "high" }, limit: { context: 1_000_000, output: 128_000 } },
  "claude-fable-5-1": { betaHeader: BETA_OPUS_5_5, thinking: ADAPTIVE, maxTokens: 128_000, outputConfig: { effort: "high" }, limit: { context: 1_000_000, output: 128_000 } },
  "claude-opus-5": { betaHeader: BETA_OPUS_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 64_000 } },
  "claude-fable-5": { betaHeader: BETA_FABLE_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 64_000 } },
  "claude-sonnet-5": { betaHeader: BETA_SONNET_5, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 64_000 } },
  "claude-opus-4-8": { betaHeader: BETA_OPUS_4_8, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "high" }, limit: { context: 1_000_000, output: 64_000 } },
  "claude-opus-4-7": { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "xhigh" }, limit: { context: 200_000, output: 64_000 } },
  "claude-opus-4-6": { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 64_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 64_000 } },
  "claude-opus-4-5-20251101": { betaHeader: BETA_EFFORT, thinking: ENABLED, maxTokens: 32_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 32_000 } },
  "claude-sonnet-4-6": { betaHeader: BETA_EFFORT, thinking: ADAPTIVE, maxTokens: 32_000, outputConfig: { effort: "high" }, limit: { context: 200_000, output: 32_000 } },
  "claude-sonnet-4-5-20250929": { betaHeader: BETA_SONNET_4_5, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
  "claude-sonnet-4-5": { betaHeader: BETA_SONNET_4_5, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
  "claude-haiku-4-5-20251001": { betaHeader: BETA_HAIKU, thinking: ENABLED, maxTokens: 32_000, limit: { context: 200_000, output: 32_000 } },
};

export const FALLBACK_ENVELOPE: ModelEnvelopeSpec = MODEL_ENVELOPES["claude-haiku-4-5-20251001"]!;

const ALIASES: Readonly<Record<string, string>> = { "claude-haiku-4-5": "claude-haiku-4-5-20251001" };

const own = (table: Readonly<Record<string, ModelEnvelopeSpec>>, key: string): ModelEnvelopeSpec | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export function envelopeFor(model: string, entry: CatalogModelEntry | undefined): ModelEnvelopeSpec {
  const alias = Object.hasOwn(ALIASES, model) ? ALIASES[model]! : "";
  const spec = own(MODEL_ENVELOPES, model) ?? own(MODEL_ENVELOPES, alias);
  if (spec) return spec;
  return entry?.capabilities ? capabilitiesEnvelope(entry) : FALLBACK_ENVELOPE;
}

export function capabilitiesEnvelope(entry: CatalogModelEntry): ModelEnvelopeSpec {
  const c = entry.capabilities;
  const adaptive = c?.thinking.types.adaptive === true;
  const maxTokens = entry.maxTokens > 0 ? Math.min(entry.maxTokens, 32_000) : 32_000;
  // Same truth table as the source's `adaptive && (levels.includes("high") ?? false)`, without its unreachable `?? false`.
  const effortSupported = c?.effort.levels.includes("high") === true && adaptive;
  return {
    betaHeader: FALLBACK_ENVELOPE.betaHeader,
    thinking: adaptive ? ADAPTIVE : ENABLED,
    maxTokens,
    ...(effortSupported ? { outputConfig: { effort: "high" } } : {}),
    limit: {
      context: entry.maxInputTokens > 0 ? entry.maxInputTokens : FALLBACK_ENVELOPE.limit.context,
      output: entry.maxTokens > 0 ? entry.maxTokens : FALLBACK_ENVELOPE.limit.output,
    },
  };
}

const CM_ALL = { clearToolUses: true, clearThinking: true, compact: true };
const CM_NO_COMPACT = { clearToolUses: true, clearThinking: true, compact: false };
const THINKING_ADAPTIVE_ONLY = { supported: true, types: { enabled: false, adaptive: true } };
const THINKING_BOTH = { supported: true, types: { enabled: true, adaptive: true } };
const THINKING_ENABLED_ONLY = { supported: true, types: { enabled: true, adaptive: false } };
const EFFORT_ALL = { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] };
const EFFORT_NO_XHIGH = { supported: true, levels: ["low", "medium", "high", "max"] };
const EFFORT_NO_MAX = { supported: true, levels: ["low", "medium", "high"] };
const EFFORT_NONE = { supported: false, levels: [] };
const BASE_CAPS = { batch: true, citations: true, imageInput: true, pdfInput: true, structuredOutputs: true };
const capsAdaptiveFull = (): ModelCapabilities => ({ ...BASE_CAPS, thinking: THINKING_ADAPTIVE_ONLY, effort: EFFORT_ALL, codeExecution: true, contextManagement: CM_ALL });
const caps46 = (): ModelCapabilities => ({ ...BASE_CAPS, thinking: THINKING_BOTH, effort: EFFORT_NO_XHIGH, codeExecution: true, contextManagement: CM_ALL });

/** Probe-validated static minimum (source: live GET /v1/models, 2026-09-01). Used when no live or cached catalog exists. */
export const STATIC_CATALOG: readonly CatalogModelEntry[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5", createdAt: "2026-07-24T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", createdAt: "2026-06-29T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: "claude-fable-5", displayName: "Claude Fable 5", createdAt: "2026-06-07T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", createdAt: "2026-05-28T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", createdAt: "2026-04-14T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: capsAdaptiveFull() },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", createdAt: "2026-02-17T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: caps46() },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", createdAt: "2026-02-04T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 128_000, capabilities: caps46() },
  { id: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", createdAt: "2025-11-24T00:00:00Z", maxInputTokens: 200_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NO_MAX, codeExecution: true, contextManagement: CM_NO_COMPACT } },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: "2025-10-15T00:00:00Z", maxInputTokens: 200_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NONE, codeExecution: false, contextManagement: CM_NO_COMPACT } },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: "2025-09-29T00:00:00Z", maxInputTokens: 1_000_000, maxTokens: 64_000, capabilities: { ...BASE_CAPS, thinking: THINKING_ENABLED_ONLY, effort: EFFORT_NONE, codeExecution: true, contextManagement: CM_NO_COMPACT } },
];
