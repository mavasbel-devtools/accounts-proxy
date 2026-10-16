// Model listing across the enabled providers (each provider's own catalog, with where it came from). In a listing of
// every provider, a provider that cannot list (a ProxyError: no account, no list and no built-in copy) is reported
// `unavailable` with its error instead of failing the whole listing (plan 2026-10-16 C4); one provider asked by name
// answers its error.
import { ProviderDisabledError, ProxyError } from "@accounts-proxy/core/domain/errors.ts";
import type { ModelCatalog, ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { ListModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";

export class ListModelsService extends ListModelsPort {
  constructor(private readonly providers: readonly ProviderPort[]) {
    super();
  }

  async listModels(provider?: ProviderId): Promise<readonly ModelCatalog[]> {
    if (provider !== undefined) {
      const one = this.providers.find((p) => p.id === provider);
      if (one === undefined) throw new ProviderDisabledError(provider);
      return [await one.models()];
    }
    const all: ModelCatalog[] = [];
    for (const p of this.providers) {
      try {
        all.push(await p.models());
      } catch (error) {
        if (!(error instanceof ProxyError)) throw error;
        all.push({ provider: p.id, formats: [], source: "unavailable", models: [], error: { code: error.code, message: error.message } });
      }
    }
    return all;
  }
}
