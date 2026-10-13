// The shared OpenCode Console session of `opencode` and `opencode-go` (decision K2) over the router's `opencode` account
// pool, with the renewal rules of OAuthSessionBase (plan v4 Phase H; Console refresh tokens are single-use, Z18). A
// service-account key never expires and is never renewed (G6).
import { activeAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { OAuthSessionBase, type SessionTokens } from "@inference-router/core/ports/outbound/session.ts";
import type { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { GatewayKeySessionPort, type KeySession } from "@inference-router/provider-gateway/ports/outbound/gateway.ts";
import { decodeCredential, encodeDevice, type ConsoleCredential, type OpencodeProvider } from "@inference-router/provider-opencode/domain/opencode.ts";
import type { ConsoleApiPort, ConsoleSessionPort } from "@inference-router/provider-opencode/ports/outbound/console.ts";

export const REFRESH_LOCK = "opencode-refresh";
/** Renew this long before the access token expires (the value of the other providers; design value). */
export const EXPIRY_BUFFER_MS = 120_000;

export class ConsoleSession extends OAuthSessionBase<ConsoleCredential> {
  protected readonly provider = "opencode";
  protected readonly lockName = REFRESH_LOCK;
  protected readonly expiryBufferMs = EXPIRY_BUFFER_MS;

  constructor(
    store: CredentialStorePort,
    private readonly api: ConsoleApiPort,
    lock: LockPort,
    clock: ClockPort,
    logger: LoggerPort,
  ) {
    super(store, lock, clock, logger);
  }

  protected tokensOf(credential: ConsoleCredential): SessionTokens {
    return credential.kind === "key" ? { accessToken: credential.key, expiresAt: Number.POSITIVE_INFINITY } : credential.tokens;
  }

  protected decode(stored: AccountCredential): ConsoleCredential | undefined {
    return decodeCredential(stored.data);
  }

  protected encode(credential: ConsoleCredential, stored: AccountCredential): AccountCredential {
    // Only a device credential is ever renewed (a key's expiry is infinite).
    const device = credential as Extract<ConsoleCredential, { kind: "device" }>;
    return { ...stored, data: encodeDevice(device.tokens, device.headers) };
  }

  protected async renew(credential: ConsoleCredential): Promise<ConsoleCredential> {
    const device = credential as Extract<ConsoleCredential, { kind: "device" }>;
    return { ...device, tokens: await this.api.refresh(device.tokens) };
  }
}

/** One OpenCode provider's view of the shared session: the bearer credential and that provider's workspace headers. */
export class ConsoleGatewaySession extends GatewayKeySessionPort {
  constructor(
    private readonly provider: OpencodeProvider,
    private readonly session: ConsoleSessionPort,
    private readonly store: CredentialStorePort,
  ) {
    super();
  }

  async active(): Promise<KeySession> {
    const { id, account } = await this.session.active();
    return { accountId: id, key: account.kind === "key" ? account.key : account.tokens.accessToken, headers: account.headers[this.provider] ?? {} };
  }

  async optionalKey(): Promise<string | undefined> {
    return activeAccount(await this.store.load("opencode")) === undefined ? undefined : (await this.active()).key;
  }
}
