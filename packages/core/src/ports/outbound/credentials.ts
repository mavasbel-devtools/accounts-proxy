import type { AccountPool } from "../../domain/accounts.ts";
import type { ProviderId } from "../../domain/models.ts";

/** The router's own per-provider account pools (never Claude Code's or the plugins' files). */
export abstract class CredentialStorePort {
  abstract load(provider: ProviderId): Promise<AccountPool>;
  abstract save(provider: ProviderId, pool: AccountPool): Promise<void>;
}
