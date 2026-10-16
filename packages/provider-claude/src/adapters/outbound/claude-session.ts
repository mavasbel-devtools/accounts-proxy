// Fresh-token session over the proxy's own Claude account pool: the shared renewal rules of OAuthSessionBase (plan v4
// H-a). Fixes the source defect "refresh has no lock" (opencode-claude-auth RefreshSessionUseCase.ts:30-49).
import type { AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import { OAuthSessionBase, type SessionTokens } from "@accounts-proxy/core/ports/outbound/session.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { ClockPort, LockPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { EXPIRY_BUFFER_MS } from "@accounts-proxy/provider-claude/domain/constants.ts";
import { fromAccount, toAccount, type ClaudeTokens } from "@accounts-proxy/provider-claude/domain/credential.ts";
import type { ClaudeOAuthPort } from "@accounts-proxy/provider-claude/ports/outbound/claude.ts";

export const REFRESH_LOCK = "claude-refresh";

export class ClaudeSession extends OAuthSessionBase<ClaudeTokens> {
  protected readonly provider = "claude";
  protected readonly lockName = REFRESH_LOCK;
  protected readonly expiryBufferMs = EXPIRY_BUFFER_MS;

  constructor(
    store: CredentialStorePort,
    private readonly oauth: ClaudeOAuthPort,
    lock: LockPort,
    clock: ClockPort,
    logger: LoggerPort,
  ) {
    super(store, lock, clock, logger);
  }

  protected tokensOf(tokens: ClaudeTokens): SessionTokens {
    return tokens;
  }

  protected decode(credential: AccountCredential): ClaudeTokens | undefined {
    return fromAccount(credential);
  }

  protected encode(tokens: ClaudeTokens, stored: AccountCredential): AccountCredential {
    return { ...toAccount(tokens), id: stored.id, label: stored.label };
  }

  protected renew(tokens: ClaudeTokens): Promise<ClaudeTokens> {
    return this.oauth.refresh(tokens);
  }
}
