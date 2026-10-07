// Durable per-install state over KeyValueStorePort. Sources: opencode-antigravity-auth @ 5c6f7c2
// DeviceIdentityStoreAdapter (persisted minted int64 sessionId, never the machine-captured literal) and
// SignatureStoreAdapter (thoughtSignature per call id, ~2000-entry oldest-eviction cap).
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
  private cache: Map<string, string> | undefined;

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
    await this.store.write(SIGNATURES_KEY, Object.fromEntries(map) as JsonObject);
  }

  private async loadOrMintSession(): Promise<string> {
    const stored = await this.store.read(SESSION_ID_KEY);
    if (isSessionId(stored)) return stored;
    const minted = mintSessionId(() => this.random.uuid());
    await this.store.write(SESSION_ID_KEY, minted);
    return minted;
  }

  private async loadSignatures(): Promise<Map<string, string>> {
    if (this.cache === undefined) {
      const stored = await this.store.read(SIGNATURES_KEY);
      const entries = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? Object.entries(stored) : [];
      this.cache = new Map(entries.filter((e): e is [string, string] => typeof e[1] === "string"));
    }
    return this.cache;
  }
}
