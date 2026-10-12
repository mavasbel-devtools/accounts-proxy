// Model list rules M1–M2: `GET /v1/models` answers `{models: [...]}`; the models with `visibility: "list"` are shown in
// the server's order as `slug` / `display_name` (openai-siwc-models-and-inference.md §1). `context_window` is read when
// it is a positive integer (the field opencode decodes, chatgpt.ts:66-75). Without a live list: the built-in slugs.
import { isJsonObject, type JsonValue } from "@inference-router/core/domain/json.ts";
import { FALLBACK_MODELS } from "@inference-router/provider-openai/domain/constants.ts";

export type CatalogEntry = { readonly id: string; readonly displayName: string; readonly contextWindow?: number };

export function parseModelList(value: unknown): CatalogEntry[] {
  if (!isJsonObject(value) || !Array.isArray(value["models"])) throw new Error("model list has no models array");
  const out: CatalogEntry[] = [];
  for (const raw of value["models"]) {
    if (!isJsonObject(raw) || raw["visibility"] !== "list" || typeof raw["slug"] !== "string" || raw["slug"] === "") continue;
    const window = raw["context_window"];
    out.push({
      id: raw["slug"],
      displayName: typeof raw["display_name"] === "string" && raw["display_name"] !== "" ? raw["display_name"] : raw["slug"],
      ...(typeof window === "number" && Number.isInteger(window) && window > 0 ? { contextWindow: window } : {}),
    });
  }
  return out;
}

export const STATIC_CATALOG: readonly CatalogEntry[] = FALLBACK_MODELS.map((id) => ({ id, displayName: id }));

/** The stored copy of a live list, for one registration (the list is per account, M1). */
export type CatalogSnapshot = { readonly version: 1; readonly clientId: string; readonly fetchedAt: number; readonly models: readonly CatalogEntry[] };

export function isSnapshot(value: JsonValue | undefined, clientId: string): value is CatalogSnapshot & JsonValue {
  return (
    isJsonObject(value) &&
    value["version"] === 1 &&
    value["clientId"] === clientId &&
    typeof value["fetchedAt"] === "number" &&
    Array.isArray(value["models"]) &&
    value["models"].every((m) => isJsonObject(m) && typeof m["id"] === "string" && typeof m["displayName"] === "string")
  );
}
