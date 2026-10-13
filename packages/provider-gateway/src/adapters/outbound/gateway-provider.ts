// An API-key gateway provider (plan P4.6 §2 item 6). Native cells: every format the model accepts (per model from the
// catalog, or uniform for the vendor); the client's request goes to the vendor's endpoint with the bare model id and the
// key in the endpoint's header, and the response streams back unchanged (rules G1–G4). A fixed key is never renewed;
// an upstream 401 reaches the client as it is (G6). Translated cells arrive in P5.
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import { UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import type { ModelCatalog, ProviderId, WireFormat } from "@inference-router/core/domain/models.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { forwardedResponseHeaders, keyHeaders, servedFormats, upstreamCall, type GatewaySpec } from "@inference-router/provider-gateway/domain/gateway.ts";
import type { GatewayCatalogPort, GatewayKeySessionPort } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";

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

  /** Translated-cell features: none until P5. */
  capabilities(): ReadonlySet<Feature> {
    return new Set<Feature>();
  }

  async models(): Promise<ModelCatalog> {
    const { source, models } = await this.catalog.listing();
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
      })),
    };
  }

  async *stream(_request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async countTokens(_request: CanonicalRequest): Promise<number> {
    throw new UnsupportedFeatureError(["translated_request"], `${this.id} (translated cells arrive in P5)`);
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    const call = upstreamCall(this.spec, model, request);
    const { key, headers } = await this.session.active();
    const response = await this.transport.send({
      method: "POST",
      url: call.url,
      headers: { ...headers, ...call.headers, ...keyHeaders(key) },
      body: call.body,
      signal: request.signal,
    });
    this.logger.info(`${this.id}: ${request.format} model=${model} -> HTTP ${response.status}`);
    return { status: response.status, headers: forwardedResponseHeaders(this.spec, response.headers), body: response.body };
  }
}
