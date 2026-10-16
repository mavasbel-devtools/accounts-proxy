// Zen / Go live model list (Z4, Z5, Z12, Z13): the public `GET /v1/models` for the ids, the reference catalog
// (models.opencode.ai, plan 2026-10-16 C3) for each model's format. The reference never fails (live, stored copy or
// built-in copy); a model it does not know is kept without formats (forwarded as sent, Z6).
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { CATALOG_TIMEOUT_MS, type GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { GatewayCatalogSourcePort } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";
import { MODELS_PATH, opencodeModels, referenceFormats, type OpencodeProvider } from "@accounts-proxy/provider-opencode/domain/opencode.ts";

export class OpencodeCatalogSource extends GatewayCatalogSourcePort {
  constructor(
    private readonly provider: OpencodeProvider,
    private readonly transport: HttpTransportPort,
    private readonly reference: ModelReferencePort,
    private readonly apiBase: string,
  ) {
    super();
  }

  async fetch(): Promise<readonly GatewayModel[]> {
    const url = `${this.apiBase}${MODELS_PATH}`;
    const res = await this.transport.send({ method: "GET", url, headers: { accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`GET ${url} HTTP ${res.status}`);
    const list: unknown = JSON.parse(text);
    return opencodeModels(list, referenceFormats((await this.reference.reference()).catalog, this.provider));
  }
}
