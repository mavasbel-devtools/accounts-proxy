// The pi extension's registration flow (architecture design §5; uc-pi-4, uc-pi-6): read the well-known
// manifest, take the token from the environment or the manifest's command, fetch the pi document, and
// register one provider per entry. run() never throws: any failure warns once and registers nothing.
import type { JsonObject, JsonValue, PiManifest, ProxyDiscoveryPort } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";
import type { TokenSourcePort } from "@accounts-proxy/pi-extension/ports/outbound/token-source.ts";
import type { PiHostPort, PiModelConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rate(cost: JsonObject | undefined, key: "input" | "output" | "cacheRead" | "cacheWrite"): number {
  const value = cost?.[key];
  return typeof value === "number" ? value : 0;
}

/** Fill pi's required model fields with its documented defaults, keeping every stated field. */
export function piDefaults(model: JsonObject): PiModelConfig {
  const id = model["id"];
  if (typeof id !== "string") throw new Error("not a pi configuration: model without a string id");
  const name = model["name"];
  const reasoning = model["reasoning"];
  const contextWindow = model["contextWindow"];
  const maxTokens = model["maxTokens"];
  const api = model["api"];
  const baseUrl = model["baseUrl"];
  const thinkingLevelMap = model["thinkingLevelMap"];
  const compat = model["compat"];
  const stated = isObject(model["cost"]) ? model["cost"] : undefined;
  return {
    id,
    ...(typeof name === "string" ? { name } : { name: id }),
    ...(typeof api === "string" ? { api } : {}),
    ...(typeof baseUrl === "string" ? { baseUrl } : {}),
    input: (model["input"] as PiModelConfig["input"] | undefined) ?? ["text"],
    cost: { input: rate(stated, "input"), output: rate(stated, "output"), cacheRead: rate(stated, "cacheRead"), cacheWrite: rate(stated, "cacheWrite") },
    reasoning: typeof reasoning === "boolean" ? reasoning : false,
    contextWindow: typeof contextWindow === "number" ? contextWindow : 128000,
    maxTokens: typeof maxTokens === "number" ? maxTokens : 16384,
    ...(isObject(thinkingLevelMap) ? { thinkingLevelMap } : {}),
    ...(isObject(compat) ? { compat } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProviderEntry = { readonly name: string | undefined; readonly apiKey: string | undefined; readonly models: JsonObject[] };

function providerEntry(id: string, entry: JsonValue): ProviderEntry {
  const record = isObject(entry) ? entry : undefined;
  const models = record?.["models"];
  if (!Array.isArray(models)) throw new Error(`not a pi configuration: provider ${id} has no model list`);
  const name = record!["name"];
  const apiKey = record!["apiKey"];
  return {
    name: typeof name === "string" ? name : undefined,
    apiKey: typeof apiKey === "string" ? apiKey : undefined,
    models: models as JsonObject[],
  };
}

export class RegisterProvidersService {
  constructor(
    private readonly discovery: ProxyDiscoveryPort,
    private readonly tokens: TokenSourcePort,
    private readonly host: PiHostPort,
  ) {}

  async run(): Promise<void> {
    try {
      const manifest = await this.discovery.manifest();
      const doc = await this.discovery.config(manifest.config.url, await this.tokenFor(manifest));
      for (const provider of this.providersOf(doc)) {
        this.host.registerProvider(provider.id, {
          ...(provider.name !== undefined ? { name: provider.name } : {}),
          ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
          models: provider.models.map(piDefaults),
          refreshModels: () => this.refresh(provider.id),
        });
      }
    } catch (error) {
      this.host.warn(`accounts-proxy: ${messageOf(error)}; no ap- providers registered`);
    }
  }

  private async tokenFor(manifest: PiManifest): Promise<string> {
    const preset = this.host.readEnv(manifest.auth.env);
    if (preset !== undefined) return preset;
    const token = await this.tokens.token(manifest.auth.command);
    this.host.setEnv(manifest.auth.env, token);
    return token;
  }

  private async refresh(id: string): Promise<readonly PiModelConfig[]> {
    const manifest = await this.discovery.manifest();
    const doc = await this.discovery.config(manifest.config.url, await this.tokenFor(manifest));
    return this.providersOf(doc).find((p) => p.id === id)?.models.map(piDefaults) ?? [];
  }

  private providersOf(doc: JsonObject): (ProviderEntry & { readonly id: string })[] {
    const providers = doc["providers"];
    if (!isObject(providers)) throw new Error("not a pi configuration: providers is not an object");
    return Object.entries(providers).map(([id, entry]) => ({ id, ...providerEntry(id, entry) }));
  }
}
