// Cheaper Inference adapters: the live model list (C3 with the key, C4 without), the key login (C6) and the wallet
// report (C7). Every call authenticates with `Authorization: Bearer` (C1).
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import type { UsageReport } from "@accounts-proxy/core/domain/usage.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { ClockPort, HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { UsageReporterPort } from "@accounts-proxy/core/ports/outbound/usage.ts";
import { GatewayKeyLogin, type KeyIdentity } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-key-login.ts";
import { CATALOG_TIMEOUT_MS, type GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { GatewayCatalogSourcePort, type GatewayKeySessionPort } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";
import { ACCOUNT_PATH, BALANCE_PATH, balanceText, MODELS_PATH, parseAccount, parseModels } from "@accounts-proxy/provider-cheaper-inference/domain/cheaper-inference.ts";

async function getJson(transport: HttpTransportPort, url: string, key: string | undefined): Promise<{ status: number; text: string }> {
  const res = await transport.send({ method: "GET", url, headers: { accept: "application/json", ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}) }, timeoutMs: CATALOG_TIMEOUT_MS });
  return { status: res.status, text: await readAll(res.body) };
}

export class CheaperCatalogSource extends GatewayCatalogSourcePort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly apiBase: string,
    private readonly publicModelsUrl: string,
  ) {
    super();
  }

  async fetch(key: string | undefined): Promise<readonly GatewayModel[]> {
    const url = key !== undefined ? `${this.apiBase}${MODELS_PATH}` : this.publicModelsUrl;
    const { status, text } = await getJson(this.transport, url, key);
    if (status !== 200) throw new Error(`model list HTTP ${status}`);
    return parseModels(JSON.parse(text));
  }
}

export class CheaperKeyLogin extends GatewayKeyLogin {
  readonly provider = "cheaper-inference";
  readonly question = "Cheaper Inference API key (dashboard → API keys, ci_live_…): ";

  constructor(
    hash: HashPort,
    private readonly transport: HttpTransportPort,
    private readonly apiBase: string,
  ) {
    super(hash);
  }

  protected async identify(key: string): Promise<KeyIdentity> {
    const { status, text } = await getJson(this.transport, `${this.apiBase}${ACCOUNT_PATH}`, key);
    if (status !== 200) throw new ProviderAuthRequiredError(this.provider, `the key was refused: HTTP ${status} ${text.slice(0, 200)}`);
    return parseAccount(JSON.parse(text));
  }
}

export class CheaperQuota extends UsageReporterPort {
  readonly provider = "cheaper-inference";

  constructor(
    private readonly transport: HttpTransportPort,
    private readonly session: GatewayKeySessionPort,
    private readonly clock: ClockPort,
    private readonly apiBase: string,
  ) {
    super();
  }

  async usage(): Promise<UsageReport> {
    const { key } = await this.session.active();
    const { status, text } = await getJson(this.transport, `${this.apiBase}${BALANCE_PATH}`, key);
    if (status !== 200) throw new Error(`cheaper-inference: GET /v1/account/balance HTTP ${status} ${text.slice(0, 200)}`);
    return { capturedAt: this.clock.now(), text: balanceText(JSON.parse(text)) };
  }
}
