import type { ReferenceCatalog } from "@inference-router/core/domain/model-details.ts";
import type { ModelsSource } from "@inference-router/core/domain/models.ts";

export type ReferenceListing = { readonly source: ModelsSource; readonly catalog: ReferenceCatalog };

/** The reference model catalog (rule M4: live, else the stored copy of the last 24 h, else the built-in copy). Never fails. */
export abstract class ModelReferencePort {
  abstract reference(): Promise<ReferenceListing>;
}
