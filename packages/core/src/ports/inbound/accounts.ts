// Inbound ports driven by the CLI.
import type { ProviderId } from "../../domain/models.ts";

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
};

export abstract class LoginPort {
  abstract login(provider: ProviderId, options: LoginOptions): Promise<AccountSummary>;
}

export abstract class AccountAdminPort {
  abstract list(provider: ProviderId): Promise<readonly AccountSummary[]>;
  abstract use(provider: ProviderId, accountId: string): Promise<AccountSummary>;
}
