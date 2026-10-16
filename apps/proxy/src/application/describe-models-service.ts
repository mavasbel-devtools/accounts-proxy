// The detailed model list (plan 2026-10-16 C2): each enabled provider's own catalog, described field by field with the
// reference catalog (rules M1–M5).
import { describeCatalog, REFERENCE_PROVIDER, type DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { DescribeModelsPort, type ListModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";

export class DescribeModelsService extends DescribeModelsPort {
  constructor(
    private readonly models: ListModelsPort,
    private readonly reference: ModelReferencePort,
  ) {
    super();
  }

  async describeModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]> {
    const catalogs = await this.models.listModels(provider);
    // The reference is read only when a listed provider has a reference provider (Cheaper Inference has none).
    const reference = catalogs.some((c) => REFERENCE_PROVIDER[c.provider] !== undefined) ? await this.reference.reference() : undefined;
    return catalogs.map((c) => describeCatalog(c, reference?.catalog, reference?.source));
  }
}
