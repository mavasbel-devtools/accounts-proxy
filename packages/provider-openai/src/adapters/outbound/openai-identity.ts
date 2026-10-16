// S4: the host id is created once per host (a proxy data directory) and reused for every sign-in; the accepted
// formats are `urn:ietf:params:oauth:jwk-thumbprint:…`, `urn:uuid:…` and `did:key:…` (openai-siwc-overview.md "Host-ID").
// The proxy creates the documented UUID form; a stored value of any accepted form is kept.
import type { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { OpenAIIdentityPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

export const HOST_ID_KEY = "openai/host-id";
const HOST_ID = /^(urn:uuid:[0-9a-f-]{36}|urn:ietf:params:oauth:jwk-thumbprint:\S+|did:key:\S+)$/;

export class OpenAIIdentity extends OpenAIIdentityPort {
  readonly sessionId: string;
  private host: Promise<string> | undefined;

  constructor(
    private readonly store: KeyValueStorePort,
    private readonly random: RandomPort,
  ) {
    super();
    this.sessionId = random.uuid();
  }

  hostId(): Promise<string> {
    this.host ??= this.loadOrCreate();
    return this.host;
  }

  private async loadOrCreate(): Promise<string> {
    const stored = await this.store.read(HOST_ID_KEY);
    if (typeof stored === "string" && HOST_ID.test(stored)) return stored;
    const created = `urn:uuid:${this.random.uuid()}`;
    await this.store.write(HOST_ID_KEY, created);
    return created;
  }
}
