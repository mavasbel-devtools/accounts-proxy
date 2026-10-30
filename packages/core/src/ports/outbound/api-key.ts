// API-key login ports (plan P4.6 decision N4): a key is entered only at a hidden prompt of `login <provider>` and stored
// only in the proxy's own account files. ApiKeyLoginPort is implemented once per API-key provider.
import type { AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

export abstract class ApiKeyLoginPort {
  abstract readonly provider: ProviderId;
  /** The prompt's question, naming the key and where it is created. */
  abstract readonly question: string;
  /** Checks the key where the provider documents a way, and builds the stored account. */
  abstract account(key: string): Promise<AccountCredential>;
}

/** Reads one secret line without echoing it. */
export abstract class SecretPromptPort {
  abstract prompt(question: string): Promise<string>;
}
