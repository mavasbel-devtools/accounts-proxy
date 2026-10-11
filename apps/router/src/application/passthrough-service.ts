// Native cells (P4): a client request in a provider's own dialect goes to that provider unchanged in shape. A model
// whose provider speaks another dialect is a translated cell (P5) and answers unsupported_feature until then.
import { ProviderDisabledError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import type { Dialect, ProviderId } from "@inference-router/core/domain/models.ts";
import { resolveModelAddress, type AliasTable } from "@inference-router/core/domain/services/model-address.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";
import { HealthPort, PassthroughPort } from "@inference-router/core/ports/inbound/routing.ts";
import type { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";

export class PassthroughService extends PassthroughPort {
  constructor(
    private readonly providers: readonly ProviderPort[],
    private readonly aliases: AliasTable,
  ) {
    super();
  }

  forward(dialect: Dialect, model: string, request: RawRequest): Promise<HttpResponse> {
    const address = resolveModelAddress(model, this.aliases);
    const provider = this.providers.find((p) => p.id === address.provider);
    if (provider === undefined) throw new ProviderDisabledError(address.provider);
    if (provider.nativeDialect !== dialect) {
      throw new UnsupportedFeatureError([`${dialect}_dialect`], `${provider.id} (it speaks ${provider.nativeDialect}; translated cells arrive in P5)`);
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
