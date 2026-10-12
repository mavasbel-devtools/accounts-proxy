// Fresh-token session over the router's own OpenAI registrations: the shared renewal rules of OAuthSessionBase (plan v4
// H-a). Refreshes are serialized across processes because the refresh token rotates and reuse is rejected (T3, T4).
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { OAuthSessionBase, type SessionTokens } from "@inference-router/core/ports/outbound/session.ts";
import type { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { EXPIRY_BUFFER_MS } from "@inference-router/provider-openai/domain/constants.ts";
import { fromAccount, toAccount, type OpenAITokens } from "@inference-router/provider-openai/domain/credential.ts";
import type { OpenAIOAuthPort } from "@inference-router/provider-openai/ports/outbound/openai.ts";

export const REFRESH_LOCK = "openai-refresh";

export class OpenAISession extends OAuthSessionBase<OpenAITokens> {
  protected readonly provider = "openai";
  protected readonly lockName = REFRESH_LOCK;
  protected readonly expiryBufferMs = EXPIRY_BUFFER_MS;

  constructor(
    store: CredentialStorePort,
    private readonly oauth: OpenAIOAuthPort,
    lock: LockPort,
    clock: ClockPort,
    logger: LoggerPort,
  ) {
    super(store, lock, clock, logger);
  }

  protected tokensOf(tokens: OpenAITokens): SessionTokens {
    return tokens;
  }

  protected decode(credential: AccountCredential): OpenAITokens | undefined {
    return fromAccount(credential);
  }

  protected encode(tokens: OpenAITokens, stored: AccountCredential): AccountCredential {
    return { ...toAccount(tokens), id: stored.id, label: stored.label };
  }

  protected renew(tokens: OpenAITokens): Promise<OpenAITokens> {
    return this.oauth.refresh(tokens);
  }
}
