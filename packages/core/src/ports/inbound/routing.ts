// Inbound (driving) ports implemented by the proxy's application services and called by the HTTP adapter.
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelCatalog, ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { HttpResponse, RawRequest } from "@accounts-proxy/core/domain/wire.ts";

export abstract class ListModelsPort {
  /** One catalog per enabled provider (configuration order), or the catalog of one provider. */
  abstract listModels(provider?: ProviderId): Promise<readonly ModelCatalog[]>;
}

export abstract class DescribeModelsPort {
  /** Every enabled provider's models in detail (plan 2026-10-16 C2), or one provider's. */
  abstract describeModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]>;
}

/** The daemon's route that refreshes the model lists (POST, token-protected; `?provider=<id>` for one provider). */
export const MODEL_REFRESH_PATH = "/proxy/v1/models/refresh";

export abstract class RefreshModelsPort {
  /**
   * Every enabled provider's model list (or one provider's) read now from its source whatever the age of the kept copy
   * (the reference catalog first when a listed provider uses it), then described as by DescribeModelsPort (plan
   * 2026-10-26 R2).
   */
  abstract refreshModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]>;
}

/** Who refreshed: the running daemon at `url`, or this process when nothing listens there. */
export type RefreshOutcome = { readonly by: "daemon" | "this process"; readonly url: string; readonly catalogs: readonly DetailedCatalog[] };

export abstract class RequestModelRefreshPort {
  /**
   * `models --refresh`: asks the running daemon to refresh its lists (they live in its memory); with nothing listening
   * on its address, refreshes them in this process, which updates the stored copies a daemon reads when it starts.
   */
  abstract request(provider?: ProviderId): Promise<RefreshOutcome>;
}

export abstract class PassthroughPort {
  /**
   * Resolves `model` (`<provider>/<model>` or an alias) and forwards the client's own request to that provider's
   * native cell. A model that does not accept `format` natively answers unsupported_feature: the proxy does not
   * translate between formats (P5 cancelled, plan 2026-10-16 D1-A).
   */
  abstract forward(format: WireFormat, model: string, request: RawRequest): Promise<HttpResponse>;
}

export abstract class HealthPort {
  abstract enabledProviders(): readonly ProviderId[];
}
