import type { ProviderId } from "../../domain/models.ts";
import type { UsageReport } from "../../domain/usage.ts";

/** Provider-reported remaining quota (for the user's manual account choice; the router never rotates, plan D4). */
export abstract class UsageReporterPort {
  abstract readonly provider: ProviderId;
  abstract usage(): Promise<UsageReport>;
}
