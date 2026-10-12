// Router configuration (`<home>/router.yaml`), validated strictly: unknown keys and wrong types are errors.
// Plan D4: a subscription provider is usable only when `enabled: true` AND `acknowledgeTermsRisk: true`; enabling it
// without the acknowledgement is a named configuration error. No file means every provider is disabled.
// Plan E5: the default port is 4141 (measured free, outside every Windows excluded range).
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import { isProviderId, PROVIDER_IDS, type ProviderId } from "@inference-router/core/domain/models.ts";
import { resolveModelAddress } from "@inference-router/core/domain/services/model-address.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`router.yaml: ${message}`);
    this.name = "ConfigError";
  }
}

export type ProviderSettings = { readonly enabled: boolean; readonly acknowledgeTermsRisk: boolean };
export type RouterConfig = {
  readonly port: number;
  readonly providers: Readonly<Record<ProviderId, ProviderSettings>>;
  readonly aliases: Readonly<Record<string, string>>;
};

export const DEFAULT_PORT = 4141;
const OFF: ProviderSettings = { enabled: false, acknowledgeTermsRisk: false };
export const DEFAULT_CONFIG: RouterConfig = { port: DEFAULT_PORT, providers: { claude: OFF, antigravity: OFF, openai: OFF }, aliases: {} };

function only(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new ConfigError(`unknown key(s) ${unknown.join(", ")} in ${where}`);
}

function bool(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return value;
}

export function parseRouterConfig(raw: unknown): RouterConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
  if (!isJsonObject(raw)) throw new ConfigError("the document must be a mapping");
  only(raw, ["port", "providers", "aliases"], "the document");
  const port = raw.port ?? DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("port must be an integer 1-65535");
  const providers: Record<ProviderId, ProviderSettings> = { claude: OFF, antigravity: OFF, openai: OFF };
  const rawProviders = raw.providers ?? {};
  if (!isJsonObject(rawProviders)) throw new ConfigError("providers must be a mapping");
  for (const [id, value] of Object.entries(rawProviders)) {
    if (!isProviderId(id)) throw new ConfigError(`unknown provider ${id} (known: ${PROVIDER_IDS.join(", ")})`);
    if (!isJsonObject(value)) throw new ConfigError(`providers.${id} must be a mapping`);
    only(value, ["enabled", "acknowledgeTermsRisk"], `providers.${id}`);
    const settings = { enabled: bool(value.enabled, `providers.${id}.enabled`, false), acknowledgeTermsRisk: bool(value.acknowledgeTermsRisk, `providers.${id}.acknowledgeTermsRisk`, false) };
    if (settings.enabled && !settings.acknowledgeTermsRisk) {
      throw new ConfigError(`providers.${id} is enabled without acknowledgeTermsRisk: true (the provider's terms restrict third-party clients)`);
    }
    providers[id] = settings;
  }
  const rawAliases = raw.aliases ?? {};
  if (!isJsonObject(rawAliases)) throw new ConfigError("aliases must be a mapping");
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(rawAliases)) {
    if (typeof target !== "string") throw new ConfigError(`aliases.${alias} must be a <provider>/<model> string`);
    try {
      resolveModelAddress(target, {});
    } catch {
      throw new ConfigError(`aliases.${alias} = ${JSON.stringify(target)} is not <provider>/<model>`);
    }
    aliases[alias] = target;
  }
  return { port, providers, aliases };
}

export function enabledProviders(config: RouterConfig): ProviderId[] {
  return PROVIDER_IDS.filter((id) => config.providers[id].enabled);
}
