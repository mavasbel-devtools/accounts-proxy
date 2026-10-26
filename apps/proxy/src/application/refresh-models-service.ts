// Model-list refresh (plan 2026-10-26 R2): each provider's list read now from its source, whatever the age of the kept
// copy; the reference catalog first, since the OpenCode and OpenAI lists and the details of every list are taken from it.
// In a refresh of every provider, a provider that cannot list (a ProxyError) is reported `unavailable` by the
// description, as in a listing (plan 2026-10-16 C4); one provider asked by name answers its error.
import { ProviderDisabledError, ProxyError } from "@accounts-proxy/core/domain/errors.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import { REFERENCE_PROVIDER } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { RefreshModelsPort, type DescribeModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import type { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";

export class RefreshModelsService extends RefreshModelsPort {
  constructor(
    private readonly providers: readonly ProviderPort[],
    private readonly reference: ModelReferencePort,
    private readonly describe: DescribeModelsPort,
  ) {
    super();
  }

  async refreshModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]> {
    const targets = provider === undefined ? this.providers : this.providers.filter((p) => p.id === provider);
    if (provider !== undefined && targets.length === 0) throw new ProviderDisabledError(provider);
    if (targets.some((p) => REFERENCE_PROVIDER[p.id] !== undefined)) await this.reference.refresh();
    for (const p of targets) {
      try {
        await p.refreshModels();
      } catch (error) {
        if (provider !== undefined || !(error instanceof ProxyError)) throw error;
      }
    }
    return this.describe.describeModels(provider);
  }
}
