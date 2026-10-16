import type { AccountPool } from "@accounts-proxy/core/domain/accounts.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

/** A pure change of one provider's pool. Returning the very same pool object means "nothing to write". */
export type PoolChange = (pool: AccountPool) => AccountPool;

/**
 * The proxy's own per-provider account pools (never Claude Code's or the plugins' files). There is no blind save:
 * every write is `update`, a read → change → write that holds across processes, so a login, `account use` and a token
 * renewal running at the same time never undo each other (plan v4 H1).
 */
export abstract class CredentialStorePort {
  abstract load(provider: ProviderId): Promise<AccountPool>;
  /** Applies `change` to the current pool under the store lock and returns the pool that is now stored. */
  abstract update(provider: ProviderId, change: PoolChange): Promise<AccountPool>;
}
