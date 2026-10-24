// Model list (M2, recon gap P4): opencode's list for a ChatGPT sign-in, the reference catalog's `openai` models with an
// allowed id, with the reference's source. The proxy makes no model-list call to OpenAI, because opencode makes none.
import { REFERENCE_PROVIDER } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import { chatgptModels } from "@accounts-proxy/provider-openai/domain/catalog.ts";
import { OpenAICatalogPort, type CatalogListing } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

export class OpenAICatalog extends OpenAICatalogPort {
  constructor(private readonly reference: ModelReferencePort) {
    super();
  }

  async listing(): Promise<CatalogListing> {
    const { source, catalog } = await this.reference.reference();
    return { source, entries: chatgptModels(catalog.get(REFERENCE_PROVIDER.openai!) ?? new Map()) };
  }
}
