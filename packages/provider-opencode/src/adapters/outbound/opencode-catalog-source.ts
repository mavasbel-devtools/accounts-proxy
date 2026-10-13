// Zen / Go live model list (Z4, Z5, Z12, Z13): the public `GET /v1/models` for the ids, models.dev for each model's format
// and limits. When models.dev cannot be read, the ids are kept without formats (forwarded as sent, Z6).
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { CATALOG_TIMEOUT_MS, type GatewayModel } from "@inference-router/provider-gateway/domain/gateway.ts";
import { GatewayCatalogSourcePort } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";
import { MODELS_PATH, modelsDevEntries, opencodeModels, type OpencodeProvider } from "@inference-router/provider-opencode/domain/opencode.ts";

export class OpencodeCatalogSource extends GatewayCatalogSourcePort {
  constructor(
    private readonly provider: OpencodeProvider,
    private readonly transport: HttpTransportPort,
    private readonly logger: LoggerPort,
    private readonly apiBase: string,
    private readonly modelsDevUrl: string,
  ) {
    super();
  }

  async fetch(): Promise<readonly GatewayModel[]> {
    const list = await this.json(`${this.apiBase}${MODELS_PATH}`);
    let details = modelsDevEntries(undefined, this.provider);
    try {
      details = modelsDevEntries(await this.json(this.modelsDevUrl), this.provider);
    } catch (error) {
      this.logger.warn(`${this.provider}: models.dev unavailable (${errorMessage(error)}); model formats unknown`);
    }
    return opencodeModels(list, details);
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.transport.send({ method: "GET", url, headers: { accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`GET ${url} HTTP ${res.status}`);
    return JSON.parse(text);
  }
}
