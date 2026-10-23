// Zen / Go model list (Z5, recon gap O5): the reference catalog (models.opencode.ai, plan 2026-10-16 C3) — the list
// OpenCode itself loads — for each provider's ids and formats. The gateway's own `GET /v1/models` is never read: the
// client never reads it. A reference read now or stored within its 24 h is the list; the reference's built-in copy, or
// a reference without this provider, fails this source, so the gateway catalog falls back to its own stored copy and
// then to its built-in list, and reports that source.
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import type { GatewayModel } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { GatewayCatalogSourcePort } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";
import { referenceModels, type OpencodeProvider } from "@accounts-proxy/provider-opencode/domain/opencode.ts";

export class OpencodeCatalogSource extends GatewayCatalogSourcePort {
  constructor(
    private readonly provider: OpencodeProvider,
    private readonly reference: ModelReferencePort,
  ) {
    super();
  }

  async fetch(): Promise<readonly GatewayModel[]> {
    const { source, catalog } = await this.reference.reference();
    if (source === "static") throw new Error("the reference model catalog is unavailable (built-in copy only)");
    const entries = catalog.get(this.provider);
    if (entries === undefined) throw new Error(`the reference model catalog has no ${this.provider} provider`);
    return referenceModels(entries);
  }
}
