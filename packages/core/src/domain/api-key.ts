// API-key accounts (plan P4.6 §2 item 3): the account's data is `{ apiKey }`. A fixed key is never renewed.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { JsonObject } from "@inference-router/core/domain/json.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";

/** The tools whose stored API keys `login <provider> --from-<tool>` can import (plan P4.6 amendment A, decision K5). */
export type KeyImportSource = "opencode";

/** `extra`: what the provider's key check reported and its requests need (e.g. the OpenCode workspace headers). */
export function apiKeyAccount(provider: ProviderId, id: string, label: string, apiKey: string, extra: JsonObject = {}): AccountCredential {
  return { provider, id, label, data: { ...extra, apiKey } };
}

/** The stored key of an API-key account. */
export function apiKeyOf(account: AccountCredential): string {
  const key = account.data["apiKey"];
  if (typeof key !== "string" || key === "") throw new ProviderAuthRequiredError(account.provider, `account ${account.id} has no API key`);
  return key;
}

/**
 * The account id of a key whose provider reports no identity: `key-` and the first 8 hex digits of the key's SHA-256
 * (a stable handle that does not reveal the key).
 */
export function keyAccountId(sha256: Uint8Array): string {
  return `key-${Array.from(sha256.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A pasted key: surrounding whitespace removed; an empty key is refused. */
export function normalizeApiKey(provider: ProviderId, input: string): string {
  const key = input.trim();
  if (key === "") throw new ProviderAuthRequiredError(provider, "no API key entered");
  return key;
}
