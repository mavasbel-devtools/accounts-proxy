// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/ModelCatalogService.ts (blob 722ede31) and the pure
// parts of application/use-cases/ResolveModelsUseCase.ts (descriptorToEntry limit rule, wireDefaults).
import { IDE_WORKING_SET_CONTEXT_CAP } from "@inference-router/provider-antigravity/domain/constants.ts";

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

/** The context window ADVERTISED to clients: catalog window clamped to the IDE working set (policy, not a model fact). */
export function advertisedContextWindow(m: Pick<ModelDescriptor, "maxTokens">): number {
  return Math.min(m.maxTokens, IDE_WORKING_SET_CONTEXT_CAP);
}

/** Catalog-exact thinking law (user decision 2026-09-26): the advertised `thinkingBudget` verbatim, else none. */
export function thinkingDefaultFor(m: ModelDescriptor): number | undefined {
  if (!m.supportsThinking || m.thinkingBudget === undefined) return undefined;
  return m.thinkingBudget;
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
    };
  });
}

/** Source descriptorToEntry: a limit exists only when BOTH maxTokens and maxOutputTokens are positive (limit law 4). */
export function advertisedLimits(m: ModelDescriptor): { readonly context: number; readonly output: number } | undefined {
  return m.maxTokens > 0 && m.maxOutputTokens > 0 ? { context: advertisedContextWindow(m), output: m.maxOutputTokens } : undefined;
}
