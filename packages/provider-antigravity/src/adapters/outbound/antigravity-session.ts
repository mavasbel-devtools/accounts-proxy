// Fresh-token session over the router's own Antigravity pool: the shared renewal rules of OAuthSessionBase (plan v4
// H-a). Ports opencode-antigravity-auth @ 5c6f7c2 RefreshSessionUseCase (refreshedActive / forceRotate) with two fixes:
//   G5 every path, including chat, refreshes proactively (source StreamChatUseCase used bare loadActive, relying on a
//      401 retry — a violation of the source's own token lifecycle law);
//   G2 the refresh is single-flight in process and runs under a cross-process lock that re-reads the pool first.
// The source's host-mirror bootstrap (opencode auth.json) is not carried: the router never reads foreign stores (D5).
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { OAuthSessionBase, type SessionTokens } from "@inference-router/core/ports/outbound/session.ts";
import type { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { fromCredential, rotated, toCredential, type AntigravityAccount } from "@inference-router/provider-antigravity/domain/account.ts";
import { EXPIRY_BUFFER_MS } from "@inference-router/provider-antigravity/domain/constants.ts";
import type { AntigravityOAuthPort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export const REFRESH_LOCK = "antigravity-refresh";

export class AntigravitySession extends OAuthSessionBase<AntigravityAccount> {
  protected readonly provider = "antigravity";
  protected readonly lockName = REFRESH_LOCK;
  protected readonly expiryBufferMs = EXPIRY_BUFFER_MS;

  constructor(
    store: CredentialStorePort,
    private readonly oauth: AntigravityOAuthPort,
    lock: LockPort,
    clock: ClockPort,
    logger: LoggerPort,
  ) {
    super(store, lock, clock, logger);
  }

  protected tokensOf(account: AntigravityAccount): SessionTokens {
    return account.tokens;
  }

  protected decode(credential: AccountCredential): AntigravityAccount | undefined {
    return fromCredential(credential);
  }

  protected encode(account: AntigravityAccount, stored: AccountCredential): AccountCredential {
    return { ...toCredential(account, stored.id), label: stored.label };
  }

  protected async renew(account: AntigravityAccount): Promise<AntigravityAccount> {
    return { ...account, tokens: rotated(account.tokens, await this.oauth.refresh(account.tokens)) };
  }
}
