// `login opencode` / `login opencode-go` (plan P4.6 §2 item 4): a Console API key at the hidden prompt. Zen has no
// authenticated read endpoint, so its key is checked for the documented prefixes (Z7); Go's key is checked once
// against `GET /zen/go/v1/usage` (Z11, status only).
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { CATALOG_TIMEOUT_MS } from "@inference-router/provider-gateway/domain/gateway.ts";
import { GatewayKeyLogin, type KeyIdentity } from "@inference-router/provider-gateway/adapters/outbound/gateway-key-login.ts";
import { checkKeyFormat, GO_USAGE_PATH, type OpencodeProvider } from "@inference-router/provider-opencode/domain/opencode.ts";

export class OpencodeKeyLogin extends GatewayKeyLogin {
  readonly question: string;

  constructor(
    readonly provider: OpencodeProvider,
    hash: HashPort,
    private readonly transport: HttpTransportPort,
    private readonly apiBase: string,
  ) {
    super(hash);
    this.question = `OpenCode ${provider === "opencode" ? "Zen" : "Go"} API key (opencode.ai Console → API keys): `;
  }

  protected async identify(key: string): Promise<KeyIdentity> {
    checkKeyFormat(key);
    if (this.provider === "opencode-go") {
      const res = await this.transport.send({ method: "GET", url: `${this.apiBase}${GO_USAGE_PATH}`, headers: { authorization: `Bearer ${key}`, accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
      const text = await readAll(res.body);
      if (res.status !== 200) throw new ProviderAuthRequiredError(this.provider, `the key was refused: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return { id: undefined, label: undefined };
  }
}
