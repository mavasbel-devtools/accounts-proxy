// Inbound (driving) ports implemented by the router's application services and called by the HTTP adapter.
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest, TranslationPolicy } from "@inference-router/core/domain/canonical/request.ts";
import type { ModelCatalog, ProviderId, WireFormat } from "@inference-router/core/domain/models.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";

export type ChatStream = {
  /** Features removed under the lossy policy (reported to the client as x-router-dropped). */
  readonly dropped: readonly Feature[];
  readonly events: AsyncIterable<CanonicalEvent>;
};

export abstract class ChatPort {
  /** Negotiates features first (so a 400 happens before any byte is streamed), then streams. */
  abstract chat(request: CanonicalRequest, policy: TranslationPolicy): Promise<ChatStream>;
}

export abstract class CountTokensPort {
  abstract countTokens(request: CanonicalRequest, policy: TranslationPolicy): Promise<number>;
}

export abstract class ListModelsPort {
  /** One catalog per enabled provider (configuration order), or the catalog of one provider. */
  abstract listModels(provider?: ProviderId): Promise<readonly ModelCatalog[]>;
}

export abstract class PassthroughPort {
  /**
   * Resolves `model` (`<provider>/<model>` or an alias) and forwards the client's own request to that provider's
   * native cell. A model that does not accept `format` natively is a translated cell: unsupported_feature (P5).
   */
  abstract forward(format: WireFormat, model: string, request: RawRequest): Promise<HttpResponse>;
}

export abstract class HealthPort {
  abstract enabledProviders(): readonly ProviderId[];
}
