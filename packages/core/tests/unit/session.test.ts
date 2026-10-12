// OAuthSessionBase: the renewal rules every subscription provider inherits (plan v4 H-a, H1, H4, H6).
import { describe, expect, test } from "bun:test";
import { EMPTY_POOL, RENEWAL_RETRY_AFTER_MS, upsertAccount, useAccount, type AccountCredential, type AccountPool } from "@inference-router/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError, UpstreamTimeoutError, UpstreamUnreachableError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { CredentialStorePort, type PoolChange } from "@inference-router/core/ports/outbound/credentials.ts";
import { OAuthSessionBase, type SessionTokens } from "@inference-router/core/ports/outbound/session.ts";
import { ClockPort, LockPort, LoggerPort } from "@inference-router/core/ports/outbound/system.ts";

type Tokens = SessionTokens & { readonly note?: string };

class Clock extends ClockPort {
  time = 1_000_000;
  now(): number {
    return this.time;
  }
}

class Lock extends LockPort {
  readonly names: string[] = [];
  before: (() => void) | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      this.names.push(name);
      this.before?.();
      return work();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

class Logger extends LoggerPort {
  readonly lines: string[] = [];
  info(m: string) {
    this.lines.push(`INFO ${m}`);
  }
  warn(m: string) {
    this.lines.push(`WARN ${m}`);
  }
  error(m: string) {
    this.lines.push(`ERROR ${m}`);
  }
}

class Store extends CredentialStorePort {
  pool: AccountPool = EMPTY_POOL;
  writes = 0;
  /** Runs at the start of update: another writer racing between the token call and the write. */
  racing: ((pool: AccountPool) => AccountPool) | undefined;
  async load(_p: ProviderId) {
    return this.pool;
  }
  async update(_p: ProviderId, change: PoolChange) {
    if (this.racing) this.pool = this.racing(this.pool);
    const next = change(this.pool);
    if (next !== this.pool) {
      this.writes += 1;
      this.pool = next;
    }
    return next;
  }
}

const credential = (id: string, t: Tokens): AccountCredential => ({ provider: "claude", id, label: `L-${id}`, data: { ...t } });

class TestSession extends OAuthSessionBase<Tokens> {
  protected readonly provider = "claude";
  protected readonly lockName = "test-refresh";
  protected readonly expiryBufferMs = 120_000;
  calls = 0;
  constructor(
    store: Store,
    lock: Lock,
    logger: Logger,
    private readonly result: (t: Tokens) => Promise<Tokens>,
    readonly time = new Clock(),
  ) {
    super(store, lock, time, logger);
  }
  protected tokensOf(t: Tokens): SessionTokens {
    return t;
  }
  protected decode(c: AccountCredential): Tokens | undefined {
    const d = c.data;
    return typeof d.accessToken === "string" && typeof d.expiresAt === "number" ? (d as Tokens) : undefined;
  }
  protected encode(t: Tokens, stored: AccountCredential): AccountCredential {
    return { ...credential(stored.id, t), label: stored.label };
  }
  protected renew(t: Tokens): Promise<Tokens> {
    this.calls += 1;
    return this.result(t);
  }
}

const renewed = (t: Tokens): Promise<Tokens> => Promise.resolve({ ...t, accessToken: `${t.accessToken}+`, expiresAt: 9_000_000 });

function setup(tokens: Tokens | undefined, result: (t: Tokens) => Promise<Tokens> = renewed) {
  const store = new Store();
  if (tokens) store.pool = upsertAccount(EMPTY_POOL, credential("me", tokens));
  const lock = new Lock();
  const logger = new Logger();
  return { store, lock, logger, session: new TestSession(store, lock, logger, result) };
}

const valid: Tokens = { accessToken: "A", refreshToken: "R", expiresAt: 1_000_000 + 120_001 };
const expiring: Tokens = { accessToken: "A", refreshToken: "R", expiresAt: 1_000_000 + 120_000 };
const expired: Tokens = { accessToken: "A", refreshToken: "R", expiresAt: 1_000_000 };

describe("OAuthSessionBase", () => {
  test("a token beyond the buffer is used as stored: no lock, no renewal", async () => {
    const { session, lock } = setup(valid);
    expect(await session.active()).toEqual({ id: "me", account: valid });
    expect([lock.names, session.calls]).toEqual([[], 0]);
  });

  test("a token inside the buffer is renewed under the lock and written with the stored id and label", async () => {
    const { session, store, lock, logger } = setup(expiring);
    expect((await session.active()).account.accessToken).toBe("A+");
    expect(lock.names).toEqual(["test-refresh"]);
    expect(store.pool.accounts[0]).toEqual({ provider: "claude", id: "me", label: "L-me", data: { accessToken: "A+", refreshToken: "R", expiresAt: 9_000_000 } });
    expect(logger.lines).toEqual(["INFO claude: access token rotated for account me"]);
  });

  test("concurrent callers share one renewal (single flight); the next expiry renews again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { session } = setup(expired, async (t) => {
      await gate;
      return renewed(t);
    });
    const all = Promise.all([session.active(), session.active(), session.active()]);
    await Bun.sleep(5);
    release();
    expect((await all).map((s) => s.account.accessToken)).toEqual(["A+", "A+", "A+"]);
    expect(session.calls).toBe(1);
  });

  test("a renewal done by another process while waiting for the lock is reused", async () => {
    const { session, store, lock } = setup(expired);
    lock.before = () => (store.pool = upsertAccount(EMPTY_POOL, credential("me", { ...valid, accessToken: "B" })));
    expect((await session.active()).account.accessToken).toBe("B");
    expect(session.calls).toBe(0);
  });

  test("H1: an `account use` that ran during the renewal is kept, and the renewed account is still written", async () => {
    const { session, store } = setup(expired);
    store.pool = upsertAccount(upsertAccount(EMPTY_POOL, credential("other", valid)), credential("me", expired));
    store.racing = (pool) => useAccount(pool, "claude", "other");
    await session.active();
    expect(store.pool.activeId).toBe("other");
    expect(store.pool.accounts.find((a) => a.id === "me")!.data.accessToken).toBe("A+");
  });

  test("H1: a new login of the same account during the renewal is kept; the renewed token serves only this call", async () => {
    const { session, store, logger } = setup(expired);
    const login = upsertAccount(EMPTY_POOL, credential("me", { ...valid, accessToken: "LOGIN" }));
    store.racing = () => login;
    expect((await session.active()).account.accessToken).toBe("A+");
    expect(store.pool).toBe(login);
    expect(store.writes).toBe(0);
    expect(logger.lines).toEqual(["INFO claude: account me was written meanwhile (new login); the renewed token serves this call only"]);
  });

  test("forceRenew renews a token the stored expiry calls valid, and reuses one renewed after `seen`", async () => {
    const { session, store } = setup(valid);
    const seen = await session.active();
    expect((await session.forceRenew(seen)).account.accessToken).toBe("A+");
    expect((await session.forceRenew(seen)).account.accessToken).toBe("A+");
    expect(session.calls).toBe(1);
    store.pool = useAccount(upsertAccount(store.pool, credential("x", valid)), "claude", "x");
    expect((await session.forceRenew(seen)).id).toBe("x");
    expect(session.calls).toBe(1);
  });

  test("H6: a rejected grant marks the account needsLogin; later calls fail fast without renewing", async () => {
    const { session, store, logger } = setup(expired, () => Promise.reject(new ProviderAuthRequiredError("claude", "grant rejected (HTTP 400)")));
    await expect(session.active()).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(store.pool.accounts[0]!.needsLogin).toBe("grant rejected (HTTP 400)");
    expect(logger.lines).toEqual(["WARN claude: account me needs a new login (grant rejected (HTTP 400))"]);
    await expect(session.active()).rejects.toThrow("claude: account me needs a new login (grant rejected (HTTP 400)); run `inference-router login claude`");
    expect(session.calls).toBe(1);
  });

  test("H6: the mark is not set on a credential a new login wrote meanwhile", async () => {
    const { session, store } = setup(expired, () => Promise.reject(new ProviderAuthRequiredError("claude", "rejected")));
    store.racing = () => upsertAccount(EMPTY_POOL, credential("me", { ...valid, accessToken: "LOGIN" }));
    await expect(session.active()).rejects.toBeInstanceOf(ProviderAuthRequiredError);
    expect(store.pool.accounts[0]!.needsLogin).toBeUndefined();
    expect(store.writes).toBe(0);
  });

  test.each([
    ["a 5xx", new UpstreamError("claude", 503, "busy")],
    ["a timeout", new UpstreamTimeoutError("auth", 30_000)],
    ["an unreachable endpoint", new UpstreamUnreachableError("auth", "refused")],
  ])("H4: %s while the stored token has not expired keeps using it", async (_name, error) => {
    const { session, store, logger } = setup(expiring, () => Promise.reject(error));
    expect((await session.active()).account.accessToken).toBe("A");
    expect(store.writes).toBe(0);
    expect(logger.lines[0]).toStartWith("WARN claude: token renewal failed (");
    expect(logger.lines[0]).toEndWith("); using the stored token of me until it expires");
  });

  test("H4: after a transient failure the same valid token is not renewed again for RENEWAL_RETRY_AFTER_MS", async () => {
    let fail = true;
    const { session, store } = setup(expiring, (t) => (fail ? Promise.reject(new UpstreamError("claude", 503, "x")) : renewed(t)));
    expect((await session.active()).account.accessToken).toBe("A");
    expect((await session.active()).account.accessToken).toBe("A");
    expect(session.calls).toBe(1);
    session.time.time += RENEWAL_RETRY_AFTER_MS - 1;
    expect((await session.active()).account.accessToken).toBe("A");
    expect(session.calls).toBe(1);
    session.time.time += 1;
    fail = false;
    expect((await session.active()).account.accessToken).toBe("A+");
    expect(session.calls).toBe(2);
    store.pool = upsertAccount(EMPTY_POOL, credential("me", expiring));
    expect((await session.active()).account.accessToken).toBe("A+");
    expect(session.calls).toBe(3);
  });

  test("H4: the cooldown belongs to one token: another stored token is renewed at once", async () => {
    let fail = true;
    const { session, store } = setup(expiring, (t) => (fail ? Promise.reject(new UpstreamError("claude", 503, "x")) : renewed(t)));
    await session.active();
    store.pool = upsertAccount(EMPTY_POOL, credential("me", { ...expiring, accessToken: "Z" }));
    fail = false;
    expect((await session.active()).account.accessToken).toBe("Z+");
  });

  test("H4: the cooldown never outlives the token: an expired token is renewed at once", async () => {
    let fail = true;
    const { session, store } = setup({ ...expiring, expiresAt: 1_000_000 + 10_000 }, (t) => (fail ? Promise.reject(new UpstreamError("claude", 503, "x")) : renewed(t)));
    await session.active();
    session.time.time += 10_000;
    fail = false;
    expect((await session.active()).account.accessToken).toBe("A+");
    expect(session.calls).toBe(2);
    expect(store.writes).toBe(1);
  });

  test("H4 does not apply to an expired token, to a non-transient failure, or to a forced renewal", async () => {
    await expect(setup(expired, () => Promise.reject(new UpstreamError("claude", 503, "x"))).session.active()).rejects.toBeInstanceOf(UpstreamError);
    await expect(setup(expiring, () => Promise.reject(new UpstreamError("claude", 404, "x"))).session.active()).rejects.toBeInstanceOf(UpstreamError);
    await expect(setup(expiring, () => Promise.reject(new Error("bad body"))).session.active()).rejects.toThrow("bad body");
    const forced = setup(valid, () => Promise.reject(new UpstreamError("claude", 503, "x")));
    await expect(forced.session.forceRenew(await forced.session.active())).rejects.toBeInstanceOf(UpstreamError);
  });

  test("no active account, an unreadable credential, or the active account removed", async () => {
    await expect(setup(undefined).session.active()).rejects.toThrow("claude: no active account");
    const { session, store } = setup(undefined);
    store.pool = upsertAccount(EMPTY_POOL, { provider: "claude", id: "bad", label: "bad", data: { x: 1 } });
    await expect(session.active()).rejects.toThrow("stored credential of bad is unreadable");
    const gone = setup(expired);
    gone.store.racing = () => upsertAccount(EMPTY_POOL, { provider: "claude", id: "me", label: "me", data: { x: 1 } });
    expect((await gone.session.active()).account.accessToken).toBe("A+");
    expect(gone.store.writes).toBe(0);
    const removed = setup(expired);
    removed.store.racing = () => EMPTY_POOL;
    expect((await removed.session.active()).account.accessToken).toBe("A+");
    expect(removed.store.pool).toBe(EMPTY_POOL);
  });
});

