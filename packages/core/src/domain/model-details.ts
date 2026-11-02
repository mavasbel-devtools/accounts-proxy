// The detailed model record (plan 2026-10-16 C2, rules M1–M6 in docs/reference/2026-10-16-01-38-model-catalog-rules.md): what a
// model accepts and produces, its limits, reasoning controls and price, each field with the source that stated it.
// The provider's own list comes first; the reference catalog (models.opencode.ai, the catalog opencode v2 loads) fills
// the fields the provider does not state; a field neither states is absent, never guessed (decision E3).
import { formatModelAddress, modelFormats, SUBSCRIPTION_PROVIDERS, type ModelCatalog, type CatalogSource, type ModelInfo, type ModelsSource, type ProviderId, type WireFormat } from "@accounts-proxy/core/domain/models.ts";

export type Modality = "text" | "image" | "audio" | "video" | "pdf";
export const MODALITIES: readonly Modality[] = ["text", "image", "audio", "video", "pdf"];

/** A reasoning control the model accepts (models.dev `reasoning_options`; opencode `Variant.Support`). */
export type ReasoningOption =
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

/** A price in USD per million tokens; a `tier` applies above a context size (models.dev `cost.tiers`). */
export type ModelCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly tier?: { readonly type: "context"; readonly size: number };
};

export type ModelStatus = "alpha" | "beta" | "deprecated";

/** The facts a model list can state beyond identity and the context/output limits of `ModelInfo`. */
export type ModelDetails = {
  readonly description?: string;
  readonly family?: string;
  /** `YYYY-MM-DD` or `YYYY-MM`, as the source states it. */
  readonly releaseDate?: string;
  readonly knowledge?: string;
  readonly status?: ModelStatus;
  readonly inputLimit?: number;
  readonly input?: readonly Modality[];
  readonly output?: readonly Modality[];
  readonly toolCall?: boolean;
  readonly structuredOutput?: boolean;
  readonly temperature?: boolean;
  readonly reasoning?: boolean;
  readonly reasoningOptions?: readonly ReasoningOption[];
  /** The response field that carries interleaved reasoning (models.dev `interleaved.field`). */
  readonly interleavedField?: string;
  readonly openWeights?: boolean;
  /** The AI SDK package the reference catalog names for the model (models.dev `provider.npm`, else the provider's). */
  readonly aiSdkPackage?: string;
  /** The first entry is the base price; later entries are context tiers. */
  readonly cost?: readonly ModelCost[];
};

/** A reference catalog entry: the details plus the fields `ModelInfo` carries. */
export type ReferenceModel = ModelDetails & {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
};

/** Reference provider id → model id → entry. */
export type ReferenceCatalog = ReadonlyMap<string, ReadonlyMap<string, ReferenceModel>>;

/** Rule M2: the reference provider each proxy provider's ids are matched in (exact ids only). */
export const REFERENCE_PROVIDER: Readonly<Record<ProviderId, string | undefined>> = {
  claude: "anthropic",
  antigravity: "google",
  openai: "openai",
  openrouter: "openrouter",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  "cheaper-inference": undefined,
};
export const REFERENCE_PROVIDERS: readonly string[] = [...new Set(Object.values(REFERENCE_PROVIDER).filter((p): p is string => p !== undefined))];

export type DetailField = "name" | "contextWindow" | "maxOutputTokens" | "createdAt" | keyof ModelDetails;

export type DetailedModel = ModelDetails & {
  /** The routable `<provider>/<model>`. */
  readonly id: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly name: string;
  readonly formats: readonly WireFormat[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly createdAt?: string;
  /** Rule M3: `provider:<id>` or `models.opencode.ai:<reference provider>/<model>` per stated field. */
  readonly sources: Readonly<Partial<Record<DetailField, string>>>;
};

export type DetailedCatalog = {
  readonly provider: ProviderId;
  readonly source: CatalogSource;
  /** Where the reference catalog came from, when the provider has a reference provider. */
  readonly referenceSource?: ModelsSource;
  readonly models: readonly DetailedModel[];
  readonly error?: { readonly code: string; readonly message: string };
};

const DETAIL_KEYS: readonly (keyof ModelDetails)[] = [
  "description",
  "family",
  "releaseDate",
  "knowledge",
  "status",
  "inputLimit",
  "input",
  "output",
  "toolCall",
  "structuredOutput",
  "temperature",
  "reasoning",
  "reasoningOptions",
  "interleavedField",
  "openWeights",
  "aiSdkPackage",
  "cost",
];

export function resolveReferenceEntry(entries: ReadonlyMap<string, ReferenceModel> | undefined, modelId: string): { readonly model: ReferenceModel; readonly referenceModelId: string } | undefined {
  if (entries === undefined) return undefined;
  const direct = entries.get(modelId);
  if (direct !== undefined) return { model: direct, referenceModelId: modelId };
  const normalized = modelId.replace(/-(extra-low|low|medium|high|tiered)$/, "");
  if (normalized !== modelId) {
    const fallback = entries.get(normalized);
    if (fallback !== undefined) return { model: fallback, referenceModelId: normalized };
  }
  return undefined;
}

/** Rules M1–M3, M5: one provider catalog described field by field. */
export function describeCatalog(catalog: ModelCatalog, reference: ReferenceCatalog | undefined, referenceSource: ModelsSource | undefined): DetailedCatalog {
  const referenceProvider = REFERENCE_PROVIDER[catalog.provider];
  const entries = referenceProvider === undefined ? undefined : reference?.get(referenceProvider);
  return {
    provider: catalog.provider,
    source: catalog.source,
    ...(catalog.error !== undefined ? { error: catalog.error } : {}),
    ...(referenceProvider !== undefined && referenceSource !== undefined ? { referenceSource } : {}),
    models: catalog.models.map((m) => {
      const match = resolveReferenceEntry(entries, m.address.model);
      return describeModel(catalog, m, referenceProvider, match?.model, match?.referenceModelId);
    }),
  };
}

function describeModel(catalog: ModelCatalog, model: ModelInfo, referenceProvider: string | undefined, reference: ReferenceModel | undefined, referenceModelId?: string): DetailedModel {
  const own = `provider:${catalog.provider}`;
  const ref = `models.opencode.ai:${referenceProvider}/${referenceModelId ?? model.address.model}`;
  const sources: Partial<Record<DetailField, string>> = {};
  const out: Record<string, unknown> = {};
  const pick = (field: DetailField, mine: unknown, theirs: unknown): void => {
    if (mine !== undefined) {
      out[field] = mine;
      sources[field] = own;
    } else if (theirs !== undefined) {
      out[field] = theirs;
      sources[field] = ref;
    }
  };
  // A model list that only repeats the id as its name states no name.
  pick("name", model.displayName !== model.address.model ? model.displayName : undefined, reference?.name);
  pick("contextWindow", model.contextWindow, reference?.contextWindow);
  pick("maxOutputTokens", model.maxOutputTokens, reference?.maxOutputTokens);
  pick("createdAt", model.createdAt, undefined);
  const details = model.details ?? {};
  for (const key of DETAIL_KEYS) {
    // Rule M5: the subscription providers carry no price.
    if (key === "cost" && SUBSCRIPTION_PROVIDERS.includes(catalog.provider)) continue;
    pick(key, details[key], reference?.[key]);
  }
  return {
    ...(out as ModelDetails),
    id: formatModelAddress(model.address),
    provider: catalog.provider,
    model: model.address.model,
    name: (out["name"] as string | undefined) ?? model.displayName,
    formats: modelFormats(catalog, model),
    ...(out["contextWindow"] !== undefined ? { contextWindow: out["contextWindow"] as number } : {}),
    ...(out["maxOutputTokens"] !== undefined ? { maxOutputTokens: out["maxOutputTokens"] as number } : {}),
    ...(out["createdAt"] !== undefined ? { createdAt: out["createdAt"] as string } : {}),
    sources,
  };
}

// ---- The reference catalog (models.dev format, `https://models.opencode.ai/api.json`) ----

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const price = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function modalities(v: unknown): Modality[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = MODALITIES.filter((m) => v.includes(m));
  return out.length > 0 ? out : undefined;
}

/** models.dev `reasoning_options`; effort values `null`/`"null"` are dropped as opencode's `supports` does. */
export function reasoningOptions(v: unknown): ReasoningOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ReasoningOption[] = [];
  for (const o of v) {
    if (!isObject(o)) continue;
    if (o["type"] === "toggle") out.push({ type: "toggle" });
    else if (o["type"] === "effort" && Array.isArray(o["values"])) out.push({ type: "effort", values: o["values"].filter((x): x is string => typeof x === "string" && x !== "" && x !== "null") });
    else if (o["type"] === "budget_tokens") {
      const min = typeof o["min"] === "number" && o["min"] >= 0 ? o["min"] : undefined;
      const max = count(o["max"]);
      out.push({ type: "budget_tokens", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
    }
  }
  return out.length > 0 ? out : undefined;
}

function cost(v: unknown): ModelCost[] | undefined {
  if (!isObject(v)) return undefined;
  const one = (c: Readonly<Record<string, unknown>>, tier?: ModelCost["tier"]): ModelCost | undefined => {
    const input = price(c["input"]);
    const output = price(c["output"]);
    if (input === undefined || output === undefined) return undefined;
    const cacheRead = price(c["cache_read"]);
    const cacheWrite = price(c["cache_write"]);
    return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), ...(tier !== undefined ? { tier } : {}) };
  };
  const base = one(v);
  if (base === undefined) return undefined;
  const tiers = (Array.isArray(v["tiers"]) ? v["tiers"] : []).flatMap((t) => {
    if (!isObject(t) || !isObject(t["tier"]) || t["tier"]["type"] !== "context") return [];
    const size = count(t["tier"]["size"]);
    const c = size === undefined ? undefined : one(t, { type: "context", size });
    return c === undefined ? [] : [c];
  });
  return [base, ...tiers];
}

function referenceModel(provider: Readonly<Record<string, unknown>>, raw: Readonly<Record<string, unknown>>): ReferenceModel {
  const limit = isObject(raw["limit"]) ? raw["limit"] : {};
  const mods = isObject(raw["modalities"]) ? raw["modalities"] : {};
  const interleaved = raw["interleaved"];
  const status = raw["status"] === "alpha" || raw["status"] === "beta" || raw["status"] === "deprecated" ? raw["status"] : undefined;
  const fields: Record<string, unknown> = {
    name: text(raw["name"]),
    contextWindow: count(limit["context"]),
    maxOutputTokens: count(limit["output"]),
    inputLimit: count(limit["input"]),
    description: text(raw["description"]),
    family: text(raw["family"]),
    releaseDate: text(raw["release_date"]),
    knowledge: text(raw["knowledge"]),
    status,
    input: modalities(mods["input"]),
    output: modalities(mods["output"]),
    toolCall: flag(raw["tool_call"]),
    structuredOutput: flag(raw["structured_output"]),
    temperature: flag(raw["temperature"]),
    reasoning: flag(raw["reasoning"]),
    reasoningOptions: reasoningOptions(raw["reasoning_options"]),
    // models-dev.ts → Model.compatibility: a string, or an object with a string `field`.
    interleavedField: typeof interleaved === "string" ? interleaved : isObject(interleaved) ? text(interleaved["field"]) : undefined,
    openWeights: flag(raw["open_weights"]),
    aiSdkPackage: text(isObject(raw["provider"]) ? raw["provider"]["npm"] : undefined) ?? text(provider["npm"]),
    cost: cost(raw["cost"]),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as ReferenceModel;
}

/** The reference providers of rule M2 out of a models.dev-format document; any other provider is ignored. */
export function parseReference(value: unknown): Map<string, Map<string, ReferenceModel>> {
  const out = new Map<string, Map<string, ReferenceModel>>();
  if (!isObject(value)) return out;
  for (const id of REFERENCE_PROVIDERS) {
    const provider = value[id];
    if (!isObject(provider) || !isObject(provider["models"])) continue;
    const models = new Map<string, ReferenceModel>();
    for (const [modelId, raw] of Object.entries(provider["models"])) if (isObject(raw)) models.set(modelId, referenceModel(provider, raw));
    out.set(id, models);
  }
  return out;
}

/** The stored form of a reference catalog (the proxy's state and the built-in copy). */
export type ReferenceRecord = Readonly<Record<string, Readonly<Record<string, ReferenceModel>>>>;

export function referenceRecord(catalog: ReferenceCatalog): ReferenceRecord {
  return Object.fromEntries([...catalog].map(([provider, models]) => [provider, Object.fromEntries(models)]));
}

/** The number of models over every provider of a reference record. */
export function countReferenceModels(record: ReferenceRecord): number {
  return Object.values(record).reduce((sum, models) => sum + Object.keys(models).length, 0);
}

export function referenceCatalog(record: ReferenceRecord): ReferenceCatalog {
  return new Map(Object.entries(record).map(([provider, models]) => [provider, new Map(Object.entries(models))]));
}

/** The stated fields only (exact optional properties); undefined when a list states none. */
export function compactDetails(fields: { readonly [K in keyof ModelDetails]-?: ModelDetails[K] | undefined }): ModelDetails | undefined {
  const stated = Object.entries(fields).filter(([, v]) => v !== undefined);
  return stated.length === 0 ? undefined : (Object.fromEntries(stated) as ModelDetails);
}

/** A decimal USD-per-token string or number as USD per million tokens (12 significant digits: no binary residue). */
export function perMillion(value: unknown, unit: "token" | "million"): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Number((unit === "token" ? n * 1_000_000 : n).toPrecision(12));
}

/** `{details}` when a list states some, else nothing (exact optional properties). */
export function withDetails(details: ModelDetails | undefined): { readonly details?: ModelDetails } {
  return details === undefined ? {} : { details };
}
