// `quota openrouter` (R8): the active key's usage and limit from `GET /key`.
import type { UsageReport } from "@inference-router/core/domain/usage.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { ClockPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";
import { CATALOG_TIMEOUT_MS } from "@inference-router/provider-gateway/domain/gateway.ts";
import type { GatewayKeySessionPort } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";
import { KEY_PATH, keyUsageText } from "@inference-router/provider-openrouter/domain/openrouter.ts";

export class OpenRouterQuota extends UsageReporterPort {
  readonly provider = "openrouter";

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
    const res = await this.transport.send({ method: "GET", url: `${this.apiBase}${KEY_PATH}`, headers: { authorization: `Bearer ${key}`, accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new Error(`openrouter: GET /key HTTP ${res.status} ${text.slice(0, 200)}`);
    return { capturedAt: this.clock.now(), text: keyUsageText(JSON.parse(text)) };
  }
}
