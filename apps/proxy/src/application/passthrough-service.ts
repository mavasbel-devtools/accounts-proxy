// Native cells (P4, P4.6): a client request in a format the model accepts natively goes to its provider unchanged in
// shape. Any other format answers unsupported_feature: the proxy does not translate between formats (P5 cancelled,
// plan 2026-10-16 D1-A). A model whose formats
// the provider does not know is forwarded as sent (plan P4.6 rule Z6).
import { ProviderDisabledError, UnsupportedFeatureError } from "@accounts-proxy/core/domain/errors.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { resolveModelAddress, type AliasTable } from "@accounts-proxy/core/domain/services/model-address.ts";
import type { HttpResponse, RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { HealthPort, PassthroughPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";

export class PassthroughService extends PassthroughPort {
  constructor(
    private readonly providers: readonly ProviderPort[],
    private readonly aliases: AliasTable,
  ) {
    super();
  }

  async forward(format: WireFormat, model: string, request: RawRequest): Promise<HttpResponse> {
    const address = resolveModelAddress(model, this.aliases);
    const provider = this.providers.find((p) => p.id === address.provider);
    if (provider === undefined) throw new ProviderDisabledError(address.provider);
    const formats = await provider.nativeFormats(address.model);
    if (formats !== undefined && !formats.has(format)) {
      throw new UnsupportedFeatureError([`${format}_format`], `${provider.id}/${address.model} (it accepts ${[...formats].join(", ")}; the proxy does not translate between formats)`);
    }
    return provider.passthrough(address.model, request);
  }
}

export class HealthService extends HealthPort {
  constructor(private readonly enabled: readonly ProviderId[]) {
    super();
  }

  enabledProviders(): readonly ProviderId[] {
    return this.enabled;
  }
}
