// Model list rule M2, recon gap P4, as opencode builds it for a ChatGPT sign-in (chatgpt.ts:301): the reference
// catalog's `openai` models, in its order, whose id is one of FALLBACK_MODELS. The details then come from the reference
// catalog like every provider's (rules M1–M6 of 2026-10-16-01-38-model-catalog-rules.md).
import type { ReferenceModel } from "@accounts-proxy/core/domain/model-details.ts";
import { FALLBACK_MODELS } from "@accounts-proxy/provider-openai/domain/constants.ts";

/** An id and its name; every other field comes from the reference catalog. */
export type CatalogEntry = { readonly id: string; readonly displayName: string };

const ALLOWED = new Set(FALLBACK_MODELS);

/** The reference provider's models opencode lists; the ids as names. */
export function chatgptModels(reference: ReadonlyMap<string, ReferenceModel>): CatalogEntry[] {
  return [...reference.keys()].filter((id) => ALLOWED.has(id)).map((id) => ({ id, displayName: id }));
}
