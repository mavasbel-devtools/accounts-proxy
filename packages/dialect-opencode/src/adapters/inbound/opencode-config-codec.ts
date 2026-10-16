// The proxy's models as an opencode v2 configuration (plan 2026-10-16 rules O1–O5; opencode v2.0.26
// schema/src/config/provider.ts, core/src/models-dev.ts `modelInfo`, core/src/aisdk-native.ts `PACKAGES`,
// core/src/wellknown.ts). One opencode provider `ap-<provider>` per proxy provider; each model names the proxy route
// of the format it is sent in, its limits, media, price and the variants opencode's own rules derive from its reasoning
// controls. Fields no source states are left out: opencode then applies its defaults.
import type { JsonObject, JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedCatalog, DetailedModel, ModelCost } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { OpencodeConfigPort, type OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import { ANTHROPIC_PACKAGE, GOOGLE_PACKAGE, OPENAI_COMPATIBLE_PACKAGE, OPENAI_PACKAGE, OPENROUTER_PACKAGE, resolveVariants, type OpencodePackage } from "@accounts-proxy/dialect-opencode/adapters/inbound/opencode-variants.ts";

export const CONFIG_SCHEMA_URL = "https://opencode.ai/config.json";
/** The variable opencode keeps the proxy token in (`auth.env`) and substitutes as `{env:…}` (config/variable.ts). */
export const TOKEN_VARIABLE = "ACCOUNTS_PROXY_TOKEN";
export const CONFIG_PATH = "/opencode/config.json";
/** opencode's default output limit (schema/src/model.ts `Info.default`), used by the variant rules when none is stated. */
const DEFAULT_OUTPUT_LIMIT = 32_000;
const LOSSY_HEADER = "x-proxy-lossy";

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  claude: "Claude",
  antigravity: "Antigravity",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "cheaper-inference": "Cheaper Inference",
};

/** Rule O2: the package and proxy route of each format. */
const FORMAT_PACKAGE: Readonly<Record<WireFormat, { readonly package: OpencodePackage; readonly path: string }>> = {
  "anthropic-messages": { package: ANTHROPIC_PACKAGE, path: "/anthropic/v1" },
  "openai-responses": { package: OPENAI_PACKAGE, path: "/openai/v1" },
  "openai-chat": { package: OPENAI_COMPATIBLE_PACKAGE, path: "/openai/v1" },
  gemini: { package: GOOGLE_PACKAGE, path: "/gemini/v1beta" },
};

/** aisdk-native.ts `PACKAGES` for the AI SDK packages whose opencode package speaks a proxy format. */
const AISDK_PACKAGE: Readonly<Record<string, { readonly package: OpencodePackage; readonly format: WireFormat }>> = {
  "@ai-sdk/anthropic": { package: ANTHROPIC_PACKAGE, format: "anthropic-messages" },
  "@ai-sdk/openai": { package: OPENAI_PACKAGE, format: "openai-responses" },
  "@ai-sdk/openai-compatible": { package: OPENAI_COMPATIBLE_PACKAGE, format: "openai-chat" },
  "@ai-sdk/google": { package: GOOGLE_PACKAGE, format: "gemini" },
  "@openrouter/ai-sdk-provider": { package: OPENROUTER_PACKAGE, format: "openai-chat" },
};

export const opencodeProviderId = (provider: ProviderId): string => `ap-${provider}`;

/** Rule O2: the reference's package when the proxy accepts its format for the model, else the model's first format. */
function connection(model: DetailedModel): { readonly package: OpencodePackage; readonly format: WireFormat } | undefined {
  const named = model.aiSdkPackage === undefined ? undefined : AISDK_PACKAGE[model.aiSdkPackage];
  if (named !== undefined && model.formats.includes(named.format)) return named;
  const format = model.formats[0];
  return format === undefined ? undefined : { package: FORMAT_PACKAGE[format].package, format };
}

/**
 * Rule O6: opencode features the subscription cells refuse, switched off with opencode's own `compatibility` overrides
 * (live C6). On `claude`, opencode's thinking-prefix controls send `thinking.block_binding` with the beta
 * `thinking-binding-controls-2026-08-01`, and a per-message effort change sends a system message with `output_config`
 * and the beta `mid-conversation-output-config-2026-07-01`; neither beta is in the captured set (F4) and the upstream
 * refuses the message field. On `openai`, the per-message effort change (`configuration_update`) is refused by plan
 * usage. With the overrides opencode changes the top-level effort instead.
 */
const COMPATIBILITY: Partial<Readonly<Record<ProviderId, JsonObject>>> = {
  claude: { supportsThinkingBlockBinding: false, supportsEffortUpdates: false },
  openai: { supportsEffortUpdates: false },
};

function compatibility(model: DetailedModel): JsonObject | undefined {
  const entry: JsonObject = {
    ...(model.interleavedField !== undefined ? { reasoningField: model.interleavedField } : {}),
    ...COMPATIBILITY[model.provider],
  };
  return Object.keys(entry).length > 0 ? entry : undefined;
}

const costEntry = (c: ModelCost): JsonObject => ({
  ...(c.tier !== undefined ? { tier: { type: c.tier.type, size: c.tier.size } } : {}),
  input: c.input,
  output: c.output,
  ...(c.cacheRead !== undefined || c.cacheWrite !== undefined ? { cache: { ...(c.cacheRead !== undefined ? { read: c.cacheRead } : {}), ...(c.cacheWrite !== undefined ? { write: c.cacheWrite } : {}) } } : {}),
});

function modelConfig(model: DetailedModel, providerId: string, origin: string): JsonObject | undefined {
  const via = connection(model);
  if (via === undefined) return undefined;
  const capabilities: JsonObject = {
    ...(model.toolCall !== undefined ? { tools: model.toolCall } : {}),
    ...(model.input !== undefined ? { input: [...model.input] } : {}),
    ...(model.output !== undefined ? { output: [...model.output] } : {}),
  };
  const limit: JsonObject = {
    ...(model.contextWindow !== undefined ? { context: model.contextWindow } : {}),
    ...(model.inputLimit !== undefined ? { input: model.inputLimit } : {}),
    ...(model.maxOutputTokens !== undefined ? { output: model.maxOutputTokens } : {}),
  };
  // Rule O4 / plugin law 1: an Antigravity thinking budget is the catalog's, so no variant can change it.
  const variants = model.provider === "antigravity" ? [] : resolveVariants({ modelID: model.model, package: via.package, outputLimit: model.maxOutputTokens ?? DEFAULT_OUTPUT_LIMIT }, model.reasoningOptions ?? []);
  const compat = compatibility(model);
  return {
    modelID: model.id,
    name: model.name,
    ...(model.family !== undefined ? { family: model.family } : {}),
    package: via.package,
    settings: { baseURL: `${origin}${FORMAT_PACKAGE[via.format].path}`, ...(via.package === OPENAI_COMPATIBLE_PACKAGE ? { provider: providerId } : {}) },
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(Object.keys(limit).length > 0 ? { limit } : {}),
    ...(model.cost !== undefined ? { cost: model.cost.map(costEntry) } : {}),
    ...(compat !== undefined ? { compatibility: compat } : {}),
    // Always written: an absent list makes opencode guess effort variants (config/plugin/provider.ts).
    variants: variants as unknown as JsonValue[],
  };
}

export class OpencodeConfigCodec extends OpencodeConfigPort {
  config(catalogs: readonly DetailedCatalog[], at: OpencodeOrigin): JsonObject {
    const providers: JsonObject = {};
    for (const catalog of catalogs) {
      // A provider that could not list its models has nothing to configure.
      if (catalog.source === "unavailable") continue;
      const id = opencodeProviderId(catalog.provider);
      const models: JsonObject = {};
      for (const model of catalog.models) {
        const entry = modelConfig(model, id, at.origin);
        if (entry !== undefined) models[model.model] = entry;
      }
      providers[id] = {
        name: `Accounts Proxy · ${PROVIDER_NAMES[catalog.provider]}`,
        settings: { apiKey: `{env:${TOKEN_VARIABLE}}` },
        // OpenAI plan usage refuses `max_output_tokens`, which opencode always sends (live validation F5).
        ...(catalog.provider === "openai" ? { headers: { [LOSSY_HEADER]: "1" } } : {}),
        models,
      };
    }
    return { $schema: CONFIG_SCHEMA_URL, providers };
  }

  manifest(at: OpencodeOrigin): JsonObject {
    return {
      auth: { command: [...at.tokenCommand], env: TOKEN_VARIABLE },
      remote_config: { url: `${at.origin}${CONFIG_PATH}`, headers: { authorization: `Bearer {env:${TOKEN_VARIABLE}}` } },
    };
  }
}
