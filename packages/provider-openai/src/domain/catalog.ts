// Model list rules M1–M2: `GET /v1/models` answers `{models: [...]}`; the models with `visibility: "list"` are shown in
// the server's order as `slug` / `display_name` (openai-siwc-models-and-inference.md §1). `context_window` is read when
// it is a positive integer (the field opencode decodes, chatgpt.ts:66-75). Without a live list: the built-in slugs.
// Plan 2026-10-16 C3: `description`, `input_modalities` and the `supported_reasoning_levels[].effort` values are kept
// as details (the captured list, tests/fixtures/captures/p0-live/l4/openai-models.json).
import { isJsonObject, type JsonValue } from "@inference-router/core/domain/json.ts";
import { compactDetails, modalities, type ModelDetails } from "@inference-router/core/domain/model-details.ts";
import { FALLBACK_MODELS } from "@inference-router/provider-openai/domain/constants.ts";

export type CatalogEntry = { readonly id: string; readonly displayName: string; readonly contextWindow?: number; readonly details?: ModelDetails };

function details(raw: Readonly<Record<string, unknown>>): ModelDetails | undefined {
  const levels = Array.isArray(raw["supported_reasoning_levels"]) ? raw["supported_reasoning_levels"] : [];
  const efforts = levels.flatMap((l) => (isJsonObject(l) && typeof l["effort"] === "string" && l["effort"] !== "" ? [l["effort"]] : []));
  const description = raw["description"];
  return compactDetails({
    description: typeof description === "string" && description !== "" ? description : undefined,
    family: undefined,
    releaseDate: undefined,
    knowledge: undefined,
    status: undefined,
    inputLimit: undefined,
    input: modalities(raw["input_modalities"]),
    output: undefined,
    toolCall: undefined,
    structuredOutput: undefined,
    temperature: undefined,
    reasoning: undefined,
    reasoningOptions: efforts.length > 0 ? [{ type: "effort", values: efforts }] : undefined,
    interleavedField: undefined,
    openWeights: undefined,
    aiSdkPackage: undefined,
    cost: undefined,
  });
}

export function parseModelList(value: unknown): CatalogEntry[] {
  if (!isJsonObject(value) || !Array.isArray(value["models"])) throw new Error("model list has no models array");
  const out: CatalogEntry[] = [];
  for (const raw of value["models"]) {
    if (!isJsonObject(raw) || raw["visibility"] !== "list" || typeof raw["slug"] !== "string" || raw["slug"] === "") continue;
    const window = raw["context_window"];
    const stated = details(raw);
    out.push({
      id: raw["slug"],
      displayName: typeof raw["display_name"] === "string" && raw["display_name"] !== "" ? raw["display_name"] : raw["slug"],
      ...(typeof window === "number" && Number.isInteger(window) && window > 0 ? { contextWindow: window } : {}),
      ...(stated !== undefined ? { details: stated } : {}),
    });
  }
  return out;
}

export const STATIC_CATALOG: readonly CatalogEntry[] = FALLBACK_MODELS.map((id) => ({ id, displayName: id }));

/** The stored copy of a live list, for one registration (the list is per account, M1). Version 2: with details. */
export type CatalogSnapshot = { readonly version: 2; readonly clientId: string; readonly fetchedAt: number; readonly models: readonly CatalogEntry[] };

export function isSnapshot(value: JsonValue | undefined, clientId: string): value is CatalogSnapshot & JsonValue {
  return (
    isJsonObject(value) &&
    value["version"] === 2 &&
    value["clientId"] === clientId &&
    typeof value["fetchedAt"] === "number" &&
    Array.isArray(value["models"]) &&
    value["models"].every((m) => isJsonObject(m) && typeof m["id"] === "string" && typeof m["displayName"] === "string")
  );
}
