// Inbound ports driven by the CLI.
import type { KeyImportSource } from "@inference-router/core/domain/api-key.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { UsageReport } from "@inference-router/core/domain/usage.ts";

export type AccountSummary = {
  readonly provider: ProviderId;
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  /** Why this account must sign in again (its refresh grant was rejected); absent when it is usable. */
  readonly needsLogin?: string;
};

export type LoginOptions = {
  /** Headless fallback: paste the code shown by the provider instead of the loopback redirect. */
  readonly manual: boolean;
  readonly timeoutMs: number;
  /** Register a new account instead of re-authorizing the active one (`--new`; see AuthorizeInput.fresh). */
  readonly fresh: boolean;
  /** Enter an API key at the hidden prompt instead of the provider's browser or device login (`--key`). */
  readonly key: boolean;
  /** Import the provider's API key once from another tool's credential file (`--from-opencode`). */
  readonly importFrom: KeyImportSource | undefined;
  /** Receives the authorization URL before the browser is opened (so the user can open it by hand). */
  readonly onAuthorizeUrl: (url: string) => void;
  /** Receives the code the user confirms on the provider's page (device login). */
  readonly onUserCode: (code: string) => void;
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
