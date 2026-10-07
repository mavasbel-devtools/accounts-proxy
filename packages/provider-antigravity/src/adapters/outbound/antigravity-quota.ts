// Source QuotaReportUseCase/QuotaService: `retrieveUserQuotaSummary` → usage view (per model group × window).
import type { ClockPort } from "@inference-router/core/ports/outbound/system.ts";
import { formatUsage, toQuotaSnapshot, type UsageView } from "@inference-router/provider-antigravity/domain/quota.ts";
import { AntigravityQuotaPort, type AntigravityApiPort, type AntigravitySessionPort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";
import { withActive } from "@inference-router/provider-antigravity/adapters/outbound/with-active.ts";

export class AntigravityQuota extends AntigravityQuotaPort {
  readonly provider = "antigravity";

  constructor(
    private readonly api: AntigravityApiPort,
    private readonly session: AntigravitySessionPort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async usage(): Promise<UsageView> {
    const raw = await withActive(this.session, (active) => this.api.retrieveUserQuotaSummary(active.account.tokens));
    return formatUsage(toQuotaSnapshot(raw, this.clock.now()));
  }
}
