// ProviderPort: the general abstraction every provider adapter extends (plan §2).
import type { ModelCatalog, ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { HttpResponse, RawRequest } from "@accounts-proxy/core/domain/wire.ts";

export abstract class ProviderPort {
  abstract readonly id: ProviderId;
  /**
   * The formats `model` accepts without translation (passthrough / near-native), or undefined when the provider does not
   * know the model's formats; such a request is forwarded as sent and the upstream answers it (plan P4.6 rule Z6).
   */
  abstract nativeFormats(model: string): Promise<ReadonlySet<WireFormat> | undefined>;
  abstract models(): Promise<ModelCatalog>;
  /** Native cell: the client's own wire request, upstream response streamed back unchanged. */
  abstract passthrough(model: string, request: RawRequest): Promise<HttpResponse>;
}
