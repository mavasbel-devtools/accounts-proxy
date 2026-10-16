// API-key login ports (plan P4.6 decision N4): a key is entered only at a hidden prompt of `login <provider>` and stored
// only in the proxy's own account files. ApiKeyLoginPort is implemented once per API-key provider.
import type { AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import type { KeyImportSource } from "@accounts-proxy/core/domain/api-key.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

export abstract class ApiKeyLoginPort {
  abstract readonly provider: ProviderId;
  /** The prompt's question, naming the key and where it is created. */
  abstract readonly question: string;
  /** Checks the key where the provider documents a way, and builds the stored account. */
  abstract account(key: string): Promise<AccountCredential>;
}

/**
 * Another tool's stored API key for one provider, read once and never written. Only API keys are imported: a stored
 * sign-in token is refused (it may rotate, and sharing it would break the other tool's session).
 */
export abstract class ForeignKeySourcePort {
  abstract readonly tool: KeyImportSource;
  /** The key the tool stores for `entry`; InvalidRequestError when it stores none, or a sign-in instead of a key. */
  abstract apiKey(entry: ProviderId): Promise<string>;
}

/** Reads one secret line without echoing it. */
export abstract class SecretPromptPort {
  abstract prompt(question: string): Promise<string>;
}
