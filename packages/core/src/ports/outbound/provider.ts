// ProviderPort: the general abstraction every provider adapter extends (plan §2).
import type { CanonicalEvent } from "../../domain/canonical/events.ts";
import type { CanonicalRequest } from "../../domain/canonical/request.ts";
import type { Dialect, ModelInfo, ProviderId } from "../../domain/models.ts";
import type { Feature } from "../../domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "../../domain/wire.ts";

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
