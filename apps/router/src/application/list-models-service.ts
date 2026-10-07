// Model listing across the enabled providers (each provider's own live catalog).
import { ProviderDisabledError } from "@inference-router/core/domain/errors.ts";
import type { ModelInfo, ProviderId } from "@inference-router/core/domain/models.ts";
import { ListModelsPort } from "@inference-router/core/ports/inbound/routing.ts";
import type { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";

export class ListModelsService extends ListModelsPort {
  constructor(private readonly providers: readonly ProviderPort[]) {
    super();
  }

  async listModels(provider?: ProviderId): Promise<readonly ModelInfo[]> {
    if (provider !== undefined) {
      const one = this.providers.find((p) => p.id === provider);
      if (one === undefined) throw new ProviderDisabledError(provider);
      return one.models();
    }
    const all: ModelInfo[] = [];
    for (const p of this.providers) all.push(...(await p.models()));
    return all;
  }
}
