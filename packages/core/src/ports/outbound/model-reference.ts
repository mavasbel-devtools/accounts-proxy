import type { ReferenceCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";

export type ReferenceListing = { readonly source: ModelsSource; readonly catalog: ReferenceCatalog };

/**
 * The reference model catalog (rule M4: live, else the stored copy younger than `modelListMaxAgeMinutes`, else the
 * built-in copy). Never fails.
 */
export abstract class ModelReferencePort {
  abstract reference(): Promise<ReferenceListing>;
  /** The catalog read now, whatever the age of the kept copy; on failure the same fallbacks (plan 2026-10-26 R2). */
  abstract refresh(): Promise<ReferenceListing>;
}
