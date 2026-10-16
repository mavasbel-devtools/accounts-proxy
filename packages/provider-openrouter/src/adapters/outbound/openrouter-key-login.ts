// `login openrouter --key` / `--from-opencode` (plan P4.6 amendment A, K3/K5): an existing OpenRouter key, checked
// against `GET /key` (R8); the key's own label names the account.
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { GatewayKeyLogin, type KeyIdentity } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-key-login.ts";
import { asObject, CATALOG_TIMEOUT_MS, firstString } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import { KEY_PATH } from "@accounts-proxy/provider-openrouter/domain/openrouter.ts";

export class OpenRouterKeyLogin extends GatewayKeyLogin {
  readonly provider = "openrouter";
  readonly question = "OpenRouter API key (https://openrouter.ai/keys): ";

  constructor(
    hash: HashPort,
    private readonly transport: HttpTransportPort,
    private readonly apiBase: string,
  ) {
    super(hash);
  }

  protected async identify(key: string): Promise<KeyIdentity> {
    const res = await this.transport.send({ method: "GET", url: `${this.apiBase}${KEY_PATH}`, headers: { authorization: `Bearer ${key}`, accept: "application/json" }, timeoutMs: CATALOG_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new ProviderAuthRequiredError(this.provider, `the key was refused: HTTP ${res.status} ${text.slice(0, 200)}`);
    return { id: undefined, label: firstString(asObject(asObject(JSON.parse(text))["data"])["label"]) };
  }
}
