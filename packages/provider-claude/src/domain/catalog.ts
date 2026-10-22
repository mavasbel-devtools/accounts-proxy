// Live `GET /v1/models` parsing. Port of opencode-claude-auth @ 6292741
// src/infrastructure/adapters/outbound/protocol/AnthropicModelsApiAdapter.ts#parseCatalogEntry (pure part).
import { compactDetails, type ModelDetails, type ReasoningOption } from "@accounts-proxy/core/domain/model-details.ts";
import type { CatalogModelEntry, ModelCapabilities } from "@accounts-proxy/provider-claude/domain/model-envelope.ts";

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

export function parseModelSelectorEntry(raw: unknown): CatalogModelEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m["id"] !== "string" || m["id"] === "") return null;
  const runtime = (typeof m["runtime"] === "object" && m["runtime"] !== null ? m["runtime"] : {}) as Record<string, unknown>;
  const caps = (typeof m["capabilities"] === "object" && m["capabilities"] !== null ? m["capabilities"] : {}) as Record<string, unknown>;
  const thinking = (typeof m["thinking"] === "object" && m["thinking"] !== null ? m["thinking"] : {}) as Record<string, unknown>;
  const effortLevels = Array.isArray(runtime["effort_levels"]) ? (runtime["effort_levels"] as string[]) : [];
  const capabilities: ModelCapabilities = {
    thinking: {
      supported: thinking["type"] !== "none",
      types: { enabled: true, adaptive: true },
    },
    effort: {
      supported: effortLevels.length > 0,
      levels: effortLevels,
    },
    batch: true,
    citations: true,
    codeExecution: true,
    imageInput: caps["mm_images"] === true,
    pdfInput: caps["mm_pdf"] === true,
    structuredOutputs: true,
    contextManagement: {
      clearToolUses: true,
      clearThinking: true,
      compact: true,
    },
  };
  const rawName = typeof m["name"] === "string" ? m["name"] : m["id"];
  const displayName = typeof rawName === "string" && !rawName.startsWith("Claude ") && rawName !== m["id"] ? `Claude ${rawName}` : String(rawName);
  return {
    id: m["id"],
    displayName,
    createdAt: "",
    maxInputTokens: typeof runtime["max_input_tokens"] === "number" ? runtime["max_input_tokens"] : 1_000_000,
    maxTokens: typeof runtime["max_output_tokens"] === "number" ? runtime["max_output_tokens"] : 128_000,
    capabilities,
  };
}

export function parseModelSelector(raw: unknown): CatalogModelEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const config = (raw as Record<string, unknown>)["model_selector_config"];
  if (!Array.isArray(config) || config.length === 0) return [];
  const cc = config.find((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>)["id"] === "cc") ?? config[0];
  if (typeof cc !== "object" || cc === null) return [];
  const models = (cc as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return [];
  const entries: CatalogModelEntry[] = [];
  for (const m of models) {
    const parsed = parseModelSelectorEntry(m);
    if (parsed) entries.push(parsed);
  }
  return entries;
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

/**
 * Plan 2026-10-16 C3: what a `/v1/models` entry states (anthropic-models-list.md `ModelCapabilities`): text input plus
 * `image_input` / `pdf_input`; `structured_outputs`; reasoning when `thinking.supported`; the `effort` levels and, for
 * `thinking.types.enabled`, a token budget of at least 1024 (anthropic-messages.md: budget_tokens "Must be ≥1024").
 */
export function entryDetails(entry: CatalogModelEntry): ModelDetails | undefined {
  const c = entry.capabilities;
  if (c === undefined) return undefined;
  const options: ReasoningOption[] = [
    ...(c.effort.supported && c.effort.levels.length > 0 ? [{ type: "effort" as const, values: c.effort.levels }] : []),
    ...(c.thinking.supported && c.thinking.types.enabled ? [{ type: "budget_tokens" as const, min: 1024 }] : []),
  ];
  return compactDetails({
    description: undefined,
    family: undefined,
    releaseDate: undefined,
    knowledge: undefined,
    status: undefined,
    inputLimit: undefined,
    input: ["text", ...(c.imageInput ? ["image" as const] : []), ...(c.pdfInput ? ["pdf" as const] : [])],
    output: undefined,
    toolCall: undefined,
    structuredOutput: c.structuredOutputs,
    temperature: undefined,
    reasoning: c.thinking.supported,
    reasoningOptions: options.length > 0 ? options : undefined,
    interleavedField: undefined,
    openWeights: undefined,
    aiSdkPackage: undefined,
    cost: undefined,
  });
}
