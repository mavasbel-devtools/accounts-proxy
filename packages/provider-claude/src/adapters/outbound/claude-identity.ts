// Wire identity for metadata.user_id / x-cc-session-id / diagnostics.previous_message_id.
// Fix F7 vs opencode-claude-auth @ 6292741 (IdentityStoreAdapter: base64url of 32 bytes): the official Claude Code
// 2.1.280 builds metadata.user_id.device_id from iD(), which is 32 random bytes as hex validated by /^[0-9a-f]{64}$/
// (binary offsets 197,801,488 and 203,147,170); the captured fixtures' sanitized device_id is 64 hex characters too.
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { ClaudeIdentityPort } from "@accounts-proxy/provider-claude/ports/outbound/claude.ts";

export const DEVICE_ID_KEY = "claude/device-id";
const DEVICE_ID = /^[0-9a-f]{64}$/;

export class ClaudeIdentity extends ClaudeIdentityPort {
  readonly sessionId: string;
  private previous: string | null = null;
  private device: Promise<string> | undefined;

  constructor(
    private readonly store: KeyValueStorePort,
    private readonly random: RandomPort,
  ) {
    super();
    this.sessionId = random.uuid();
  }

  deviceId(): Promise<string> {
    this.device ??= this.loadOrCreate();
    return this.device;
  }

  previousMessageId(): string | null {
    return this.previous;
  }

  setPreviousMessageId(id: string): void {
    this.previous = id;
  }

  private async loadOrCreate(): Promise<string> {
    const stored = await this.store.read(DEVICE_ID_KEY);
    if (typeof stored === "string" && DEVICE_ID.test(stored)) return stored;
    const created = [...this.random.bytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.store.write(DEVICE_ID_KEY, created);
    return created;
  }
}
