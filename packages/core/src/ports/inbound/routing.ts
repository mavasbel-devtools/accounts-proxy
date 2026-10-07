// Inbound (driving) ports implemented by the router's application services and called by the HTTP adapter.
import type { CanonicalEvent } from "../../domain/canonical/events.ts";
import type { CanonicalRequest, TranslationPolicy } from "../../domain/canonical/request.ts";
import type { Dialect, ModelInfo, ProviderId } from "../../domain/models.ts";
import type { Feature } from "../../domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "../../domain/wire.ts";

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
  /** Models of every enabled provider, or of one provider. */
  abstract listModels(provider?: ProviderId): Promise<readonly ModelInfo[]>;
}

export abstract class PassthroughPort {
  /** True when `model` resolves to a provider whose native dialect is `dialect`. */
  abstract isNative(dialect: Dialect, model: string): boolean;
  abstract forward(dialect: Dialect, model: string, request: RawRequest): Promise<HttpResponse>;
}
