// Inbound ports driven by the CLI.
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { UsageReport } from "@inference-router/core/domain/usage.ts";

export type AccountSummary = {
  readonly provider: ProviderId;
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
};

export type LoginOptions = {
  /** Headless fallback: paste the code shown by the provider instead of the loopback redirect. */
  readonly manual: boolean;
  readonly timeoutMs: number;
  /** Receives the authorization URL before the browser is opened (so the user can open it by hand). */
  readonly onAuthorizeUrl: (url: string) => void;
};

export abstract class LoginPort {
  abstract login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary>;
}

export abstract class AccountAdminPort {
  abstract list(provider: ProviderId): Promise<readonly AccountSummary[]>;
  abstract use(provider: ProviderId, accountId: string): Promise<AccountSummary>;
}

export abstract class UsagePort {
  abstract usage(provider: ProviderId): Promise<UsageReport>;
}
