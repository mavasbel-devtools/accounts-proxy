// Live `GET /v1/models` parsing. Port of opencode-claude-auth @ 6292741
// src/infrastructure/adapters/outbound/protocol/AnthropicModelsApiAdapter.ts#parseCatalogEntry (pure part).
import type { CatalogModelEntry, ModelCapabilities } from "@inference-router/provider-claude/domain/model-envelope.ts";

type Flag = { readonly supported?: unknown } | undefined;
export type ModelsApiEntry = {
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly created_at?: unknown;
  readonly max_input_tokens?: unknown;
  readonly max_tokens?: unknown;
  readonly capabilities?: {
    readonly batch?: Flag;
    readonly citations?: Flag;
    readonly code_execution?: Flag;
    readonly context_management?: { readonly clear_tool_uses_20250919?: Flag; readonly clear_thinking_20251015?: Flag; readonly compact_20260112?: Flag };
    readonly effort?: { readonly supported?: unknown; readonly [level: string]: unknown };
    readonly image_input?: Flag;
    readonly pdf_input?: Flag;
    readonly structured_outputs?: Flag;
    readonly thinking?: { readonly supported?: unknown; readonly types?: { readonly enabled?: Flag; readonly adaptive?: Flag } };
  };
};
export type ModelsPage = { readonly data?: readonly ModelsApiEntry[]; readonly has_more?: unknown; readonly last_id?: unknown };

const EFFORT_KEYS = ["low", "medium", "high", "xhigh", "max"] as const;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const bool = (v: unknown): boolean => v === true;
const flag = (v: unknown): boolean => typeof v === "object" && v !== null && (v as { supported?: unknown }).supported === true;

export function parseCatalogEntry(raw: ModelsApiEntry): CatalogModelEntry | null {
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const c = raw.capabilities;
  const capabilities: ModelCapabilities = {
    thinking: {
      supported: bool(c?.thinking?.supported),
      types: { enabled: flag(c?.thinking?.types?.enabled), adaptive: flag(c?.thinking?.types?.adaptive) },
    },
    effort: { supported: bool(c?.effort?.supported), levels: EFFORT_KEYS.filter((k) => flag(c?.effort?.[k])) },
    batch: flag(c?.batch),
    citations: flag(c?.citations),
    codeExecution: flag(c?.code_execution),
    imageInput: flag(c?.image_input),
    pdfInput: flag(c?.pdf_input),
    structuredOutputs: flag(c?.structured_outputs),
    contextManagement: {
      clearToolUses: flag(c?.context_management?.clear_tool_uses_20250919),
      clearThinking: flag(c?.context_management?.clear_thinking_20251015),
      compact: flag(c?.context_management?.compact_20260112),
    },
  };
  return {
    id: raw.id,
    displayName: typeof raw.display_name === "string" ? raw.display_name : raw.id,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    maxInputTokens: num(raw.max_input_tokens),
    maxTokens: num(raw.max_tokens),
    capabilities,
  };
}

/** Next pagination cursor: `last_id`, else the last parsed id (source contract); undefined ends paging. */
export function nextCursor(page: ModelsPage, parsedSoFar: readonly CatalogModelEntry[]): string | undefined {
  if (page.has_more !== true) return undefined;
  if (typeof page.last_id === "string" && page.last_id !== "") return page.last_id;
  return parsedSoFar[parsedSoFar.length - 1]?.id;
}

export type CatalogSnapshot = { readonly version: 2; readonly fetchedAt: number; readonly models: readonly CatalogModelEntry[] };

export function isSnapshot(value: unknown): value is CatalogSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { version?: unknown; fetchedAt?: unknown; models?: unknown };
  return v.version === 2 && typeof v.fetchedAt === "number" && Array.isArray(v.models) && v.models.length > 0;
}
