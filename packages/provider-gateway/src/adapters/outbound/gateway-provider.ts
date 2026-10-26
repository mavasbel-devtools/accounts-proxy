// An API-key gateway provider (plan P4.6 §2 item 6). Native cells: every format the model accepts (per model from the
// catalog, or uniform for the vendor); the client's request goes to the vendor's endpoint with the bare model id and the
// key in the endpoint's header, and the response streams back unchanged (rules G1–G4). A fixed key is never renewed;
// an upstream 401 reaches the client as it is (G6).
import type { ModelCatalog, ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { HttpResponse, RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import type { LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { forwardedResponseHeaders, keyHeaders, servedFormats, upstreamCall, type GatewaySpec } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import type { GatewayCatalogPort, GatewayKeySessionPort, GatewayListing } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";

export class GatewayProvider extends ProviderPort {
  constructor(
    private readonly spec: GatewaySpec,
    private readonly session: GatewayKeySessionPort,
    private readonly catalog: GatewayCatalogPort,
    private readonly transport: HttpTransportPort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  get id(): ProviderId {
    return this.spec.provider;
  }

  async nativeFormats(model: string): Promise<ReadonlySet<WireFormat> | undefined> {
    if (this.spec.uniformFormats !== undefined) return new Set(this.spec.uniformFormats);
    const formats = (await this.catalog.listing()).models.find((m) => m.id === model)?.formats;
    return formats === undefined ? undefined : new Set(servedFormats(this.spec, formats));
  }

  async models(): Promise<ModelCatalog> {
    return this.catalogOf(await this.catalog.listing());
  }

  override async refreshModels(): Promise<ModelCatalog> {
    return this.catalogOf(await this.catalog.refresh());
  }

  private catalogOf({ source, models }: GatewayListing): ModelCatalog {
    return {
      provider: this.id,
      formats: this.spec.uniformFormats ?? [],
      source,
      models: models.map((m) => ({
        address: { provider: this.id, model: m.id },
        displayName: m.displayName,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
        ...(m.formats !== undefined ? { formats: servedFormats(this.spec, m.formats) } : {}),
        ...(m.details !== undefined ? { details: m.details } : {}),
      })),
    };
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    const call = upstreamCall(this.spec, model, request);
    const { key, headers } = await this.session.active();
    const response = await this.transport.send({
      method: "POST",
      url: call.url,
      headers: { ...headers, ...call.headers, ...keyHeaders(key, call.keyHeader) },
      body: call.body,
      signal: request.signal,
    });
    this.logger.info(`${this.id}: ${request.format} model=${model} -> HTTP ${response.status}`);
    return { status: response.status, headers: forwardedResponseHeaders(this.spec, response.headers), body: response.body };
  }
}
