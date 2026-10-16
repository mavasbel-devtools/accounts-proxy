// Inbound (driving) ports implemented by the router's application services and called by the HTTP adapter.
import type { ModelCatalog, ProviderId, WireFormat } from "@inference-router/core/domain/models.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";

export abstract class ListModelsPort {
  /** One catalog per enabled provider (configuration order), or the catalog of one provider. */
  abstract listModels(provider?: ProviderId): Promise<readonly ModelCatalog[]>;
}

export abstract class PassthroughPort {
  /**
   * Resolves `model` (`<provider>/<model>` or an alias) and forwards the client's own request to that provider's
   * native cell. A model that does not accept `format` natively answers unsupported_feature: the router does not
   * translate between formats (P5 cancelled, plan 2026-10-16 D1-A).
   */
  abstract forward(format: WireFormat, model: string, request: RawRequest): Promise<HttpResponse>;
}

export abstract class HealthPort {
  abstract enabledProviders(): readonly ProviderId[];
}
