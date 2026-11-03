// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/ModelCatalogService.ts (blob 722ede31) and the pure
// parts of application/use-cases/ResolveModelsUseCase.ts (descriptorToEntry limit rule, wireDefaults). The limits follow
// @ ba0ae60, which retired the 80k advertised-window clamp (plan 2026-11-02-21-29).
import type { Modality, ModelDetails } from "@accounts-proxy/core/domain/model-details.ts";

export type ModelDescriptor = {
  readonly wireId: string;
  readonly displayName: string;
  readonly maxTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsImages: boolean;
  readonly supportsThinking: boolean;
  readonly supportsVideo: boolean;
  readonly thinkingBudget?: number;
  readonly minThinkingBudget?: number;
  readonly recommended: boolean;
  readonly tagTitle?: string;
  /** `labels.model_enum` placeholder (MODEL_PLACEHOLDER_Mxx) required by every stream request. */
  readonly enumPlaceholder: string;
  readonly quota?: { readonly remainingFraction: number; readonly resetTime: string };
  /** Proxy addition (plan 2026-10-16 C3): the `supportedMimeTypes` the catalog marks true. */
  readonly mimeTypes?: readonly string[];
};

export type ExcludedModel = { readonly wireId: string; readonly reason: "tab-completion" | "deprecated"; readonly replacement?: string };

type RawModel = {
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  supportsVideo?: boolean;
  thinkingBudget?: number;
  minThinkingBudget?: number;
  recommended?: boolean;
  tagTitle?: string;
  model?: string;
  quotaInfo?: { remainingFraction?: number; resetTime?: string };
  supportedMimeTypes?: Record<string, unknown>;
};

export function excludedModelIds(raw: Readonly<Record<string, unknown>>): ExcludedModel[] {
  const out: ExcludedModel[] = [];
  const tab = raw["tabModelIds"];
  if (Array.isArray(tab)) for (const id of tab) if (typeof id === "string") out.push({ wireId: id, reason: "tab-completion" });
  const deprecated = raw["deprecatedModelIds"];
  if (deprecated && typeof deprecated === "object" && !Array.isArray(deprecated)) {
    for (const [id, meta] of Object.entries(deprecated as Record<string, unknown>)) {
      const replacement =
        meta && typeof meta === "object" && typeof (meta as { newModelId?: unknown }).newModelId === "string"
          ? (meta as { newModelId: string }).newModelId
          : undefined;
      out.push({ wireId: id, reason: "deprecated", ...(replacement !== undefined ? { replacement } : {}) });
    }
  }
  return out;
}

/** Catalog-exact thinking law (user decision 2026-09-26): the advertised `thinkingBudget` verbatim, else none. */
export function thinkingDefaultFor(m: ModelDescriptor): number | undefined {
  if (!m.supportsThinking || m.thinkingBudget === undefined) return undefined;
  return m.thinkingBudget;
}

function mimeTypesOf(value: Record<string, unknown> | undefined): { readonly mimeTypes?: readonly string[] } {
  const types = Object.entries(value ?? {}).flatMap(([type, on]) => (on === true ? [type] : []));
  return types.length > 0 ? { mimeTypes: types } : {};
}

/**
 * Plan 2026-10-16 C3: text input, plus image (`supportsImages` or an `image/*` type), video (`supportsVideo` or a
 * `video/*` type), audio (an `audio/*` type) and pdf (`application/pdf`); reasoning is `supportsThinking`.
 */
export function descriptorDetails(m: ModelDescriptor): ModelDetails {
  const types = m.mimeTypes ?? [];
  const any = (prefix: string) => types.some((t) => t.startsWith(prefix));
  const input: Modality[] = ["text"];
  if (m.supportsImages || any("image/")) input.push("image");
  if (any("audio/")) input.push("audio");
  if (m.supportsVideo || any("video/")) input.push("video");
  if (types.includes("application/pdf")) input.push("pdf");
  const isImageModel = m.wireId.endsWith("-image");
  const isTab = m.wireId.startsWith("tab_") || m.wireId.startsWith("chat_");
  const toolCall = !isImageModel && !isTab;
  return { input, reasoning: m.supportsThinking, toolCall };
}

export function toModelDescriptors(raw: Readonly<Record<string, unknown>>): ModelDescriptor[] {
  const models = (raw["models"] ?? {}) as Record<string, RawModel>;
  const excluded = new Set(excludedModelIds(raw).map((e) => e.wireId));
  const entries = Object.entries(models).filter(([wireId]) => !excluded.has(wireId));
  const nameCounts = new Map<string, number>();
  for (const [, m] of entries) {
    const name = m.displayName ?? "";
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return entries.map(([wireId, m]) => {
    const baseName = m.displayName ?? wireId;
    const displayName = (nameCounts.get(baseName) ?? 0) > 1 ? `${baseName} (${wireId})` : baseName;
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
      enumPlaceholder: m.model ?? "",
      ...(m.quotaInfo?.remainingFraction !== undefined && m.quotaInfo.resetTime
        ? { quota: { remainingFraction: m.quotaInfo.remainingFraction, resetTime: m.quotaInfo.resetTime } }
        : {}),
      ...mimeTypesOf(m.supportedMimeTypes),
    };
  });
}

/**
 * Source descriptorToEntry @ ba0ae60 (ResolveModelsUseCase.ts:65-70): the catalog's windows verbatim, and a limit exists
 * only when BOTH maxTokens and maxOutputTokens are positive (limit law 4).
 */
export function advertisedLimits(m: ModelDescriptor): { readonly context: number; readonly output: number } | undefined {
  return m.maxTokens > 0 && m.maxOutputTokens > 0 ? { context: m.maxTokens, output: m.maxOutputTokens } : undefined;
}
