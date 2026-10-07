import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { UsageReport } from "@inference-router/core/domain/usage.ts";

/** Provider-reported remaining quota (for the user's manual account choice; the router never rotates, plan D4). */
export abstract class UsageReporterPort {
  abstract readonly provider: ProviderId;
  abstract usage(): Promise<UsageReport>;
}
