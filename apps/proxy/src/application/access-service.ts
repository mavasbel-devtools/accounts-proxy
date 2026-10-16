// The proxy token (plan D6): 32 random bytes, base64url, created on first use and stored owner-only. A presented
// token is compared through SHA-256 digests of both values with a constant-time equality, so neither the token's
// length nor its content leaks through timing.
import { base64UrlEncode } from "@accounts-proxy/core/domain/services/base64url.ts";
import { constantTimeEqual } from "@accounts-proxy/core/domain/services/constant-time.ts";
import { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import type { ProxyTokenStorePort } from "@accounts-proxy/core/ports/outbound/proxy-token.ts";
import type { HashPort, RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export const TOKEN_BYTES = 32;

export class AccessService extends AccessPort {
  private current: Promise<string> | undefined;

  constructor(
    private readonly store: ProxyTokenStorePort,
    private readonly random: RandomPort,
    private readonly hash: HashPort,
  ) {
    super();
  }

  token(): Promise<string> {
    this.current ??= this.loadOrCreate();
    return this.current;
  }

  async authorize(candidate: string | undefined): Promise<boolean> {
    if (candidate === undefined) return false;
    return constantTimeEqual(this.hash.sha256(candidate), this.hash.sha256(await this.token()));
  }

  private async loadOrCreate(): Promise<string> {
    const stored = await this.store.read();
    if (stored !== undefined) return stored;
    const token = base64UrlEncode(this.random.bytes(TOKEN_BYTES));
    await this.store.write(token);
    return token;
  }
}
