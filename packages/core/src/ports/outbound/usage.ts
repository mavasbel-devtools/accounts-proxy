import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import type { UsageReport } from "@accounts-proxy/core/domain/usage.ts";

/** Provider-reported remaining quota (for the user's manual account choice; the proxy never rotates, plan D4). */
export abstract class UsageReporterPort {
  abstract readonly provider: ProviderId;
  abstract usage(): Promise<UsageReport>;
}
