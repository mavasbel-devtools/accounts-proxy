// Durable per-install state over KeyValueStorePort. Sources: opencode-antigravity-auth @ 5c6f7c2
// DeviceIdentityStoreAdapter (persisted minted int64 sessionId, never the machine-captured literal) and
// SignatureStoreAdapter (thoughtSignature per call id, ~2000-entry oldest-eviction cap). Router fix: the store is read
// once even by concurrent first callers, and writes never overlap: while one runs, the next is queued once and stores
// the map as it is when it starts, so the last write always holds the newest map (fire-and-forget saves used to race,
// and an older snapshot could land last — found by the e2e cap test, 2026-10-11).
import type { JsonObject } from "@inference-router/core/domain/json.ts";
import type { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import type { RandomPort } from "@inference-router/core/ports/outbound/system.ts";
import { SIGNATURE_CAP } from "@inference-router/provider-antigravity/domain/constants.ts";
import { isSessionId, mintSessionId } from "@inference-router/provider-antigravity/domain/trajectory.ts";
import { AntigravityStatePort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export const SESSION_ID_KEY = "antigravity/session-id";
export const SIGNATURES_KEY = "antigravity/thought-signatures";

export class AntigravityState extends AntigravityStatePort {
  private session: Promise<string> | undefined;
  private loaded: Promise<Map<string, string>> | undefined;
  /** The write in flight (settled), and the one queued behind it. */
  private writing: Promise<void> = Promise.resolve();
  private queued: Promise<void> | undefined;

  constructor(
    private readonly store: KeyValueStorePort,
    private readonly random: RandomPort,
    private readonly cap: number = SIGNATURE_CAP,
  ) {
    super();
  }

  sessionId(): Promise<string> {
    this.session ??= this.loadOrMintSession();
    return this.session;
  }

  async signatures(): Promise<Readonly<Record<string, string>>> {
    return Object.fromEntries(await this.loadSignatures());
  }

  /** Insertion order is age order: a re-captured id moves to the newest end; the oldest are evicted past the cap. */
  async saveSignature(callId: string, signature: string): Promise<void> {
    const map = await this.loadSignatures();
    map.delete(callId);
    map.set(callId, signature);
    while (map.size > this.cap) map.delete(map.keys().next().value!);
    return this.flush(map);
  }

  private flush(map: Map<string, string>): Promise<void> {
    if (this.queued === undefined) {
      const queued = this.writing.then(() => {
        this.queued = undefined;
        return this.store.write(SIGNATURES_KEY, Object.fromEntries(map) as JsonObject);
      });
      this.queued = queued;
      this.writing = queued.catch(() => undefined);
    }
    return this.queued;
  }

  private async loadOrMintSession(): Promise<string> {
    const stored = await this.store.read(SESSION_ID_KEY);
    if (isSessionId(stored)) return stored;
    const minted = mintSessionId(() => this.random.uuid());
    await this.store.write(SESSION_ID_KEY, minted);
    return minted;
  }

  private loadSignatures(): Promise<Map<string, string>> {
    this.loaded ??= this.readSignatures();
    return this.loaded;
  }

  private async readSignatures(): Promise<Map<string, string>> {
    const stored = await this.store.read(SIGNATURES_KEY);
    const entries = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? Object.entries(stored) : [];
    return new Map(entries.filter((e): e is [string, string] => typeof e[1] === "string"));
  }
}
