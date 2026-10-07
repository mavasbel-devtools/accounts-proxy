// ProviderPort: the general abstraction every provider adapter extends (plan §2).
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import type { Dialect, ModelInfo, ProviderId } from "@inference-router/core/domain/models.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";

export abstract class ProviderPort {
  abstract readonly id: ProviderId;
  /** The client dialect this provider can serve without translation (passthrough / near-native). */
  abstract readonly nativeDialect: Dialect;
  /** Features the provider carries in a TRANSLATED request (from P0-E3 measurements only). */
  abstract capabilities(): ReadonlySet<Feature>;
  abstract models(): Promise<readonly ModelInfo[]>;
  /** Translated cell: canonical request in, canonical events out. */
  abstract stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent>;
  abstract countTokens(request: CanonicalRequest): Promise<number>;
  /** Native cell: the client's own wire request, upstream response streamed back unchanged. */
  abstract passthrough(model: string, request: RawRequest): Promise<HttpResponse>;
}
