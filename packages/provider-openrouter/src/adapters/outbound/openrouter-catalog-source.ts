// OpenRouter's live model list (R4): `GET /models`, public (no key).
import { CATALOG_TIMEOUT_MS, type GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { GatewayCatalogSourcePort } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";
import { MODELS_PATH, parseModels } from "@accounts-proxy/provider-openrouter/domain/openrouter.ts";

export class OpenRouterCatalogSource extends GatewayCatalogSourcePort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  async fetch(): Promise<readonly GatewayModel[]> {
    const res = await this.transport.send({ method: "GET", url: `${this.apiBase}${MODELS_PATH}`, headers: { accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`model list HTTP ${res.status}`);
    return parseModels(JSON.parse(text));
  }
}
