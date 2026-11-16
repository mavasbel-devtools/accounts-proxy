// The proxy's models as a pi models.json configuration and well-known manifest (plan 2026-11-15-23-52 rules
// P1–P7, docs/design/2026-11-15-23-52-pi-compatibility-product.md §4). One pi provider `ap-<provider>` per proxy
// provider; each model names the proxy route of the format it is sent in, its limits, media, price, thinking rules
// and the compat pi detects for that vendor's own host. Fields no source states are left out: pi then applies its
// documented defaults.
import { chooseFormat, PROVIDER_DISPLAY_NAMES } from "@accounts-proxy/core/domain/client-connection.ts";
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedCatalog, DetailedModel, ModelCost } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";
import { PiConfigPort } from "@accounts-proxy/core/ports/inbound/pi.ts";
import { piThinking, type PiApi } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-thinking.ts";

export const PI_CONFIG_PATH = "/pi/models.json";
export const PI_SCHEMA_URL = "https://pi.dev/schemas/models.schema.json";
/** The variable pi keeps the proxy token in (`$NAME` interpolation, pi `docs/models.md:65`). */
export const TOKEN_VARIABLE = "ACCOUNTS_PROXY_TOKEN";

export const piProviderId = (provider: ProviderId): string => `ap-${provider}`;

/** Rule P2: the pi api and proxy route of each format. */
export const PI_API: Readonly<Record<WireFormat, { readonly api: PiApi; readonly path: string }>> = {
  "anthropic-messages": { api: "anthropic-messages", path: "/anthropic" },
  "openai-chat": { api: "openai-completions", path: "/openai/v1" },
  "openai-responses": { api: "openai-responses", path: "/openai/v1" },
  gemini: { api: "google-generative-ai", path: "/gemini/v1beta" },
};

/** Rule P5: subscription cells, verbatim from the product design. */
export const SUBSCRIPTION_COMPAT: Partial<Readonly<Record<ProviderId, JsonObject>>> = {
  claude: { supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, supportsMessageThreads: false },
  openai: { supportsMaxOutputTokens: false, supportsMidConvoEffort: false },
};

/**
 * Rule P6: each ap-<gateway> model gets the compat pi detects for that vendor's own host. cheaper-inference: none
 * (pi detects nothing for its host). pi's per-model catalog compat is not copied.
 */
export function gatewayCompat(model: DetailedModel, api: PiApi): JsonObject | undefined {
  if (model.provider === "openrouter") {
    if (api === "openai-completions") {
      return {
        thinkingFormat: "openrouter",
        sendSessionAffinityHeaders: true,
        sessionAffinityFormat: "openrouter",
        ...(model.model.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" } : {}),
        ...(!model.model.startsWith("anthropic/") && !model.model.startsWith("openai/") ? { supportsDeveloperRole: false } : {}),
      };
    }
    if (api === "anthropic-messages") return { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };
    if (api === "openai-responses") return { sessionAffinityFormat: "openrouter" };
    return undefined;
  }
  if ((model.provider === "opencode" || model.provider === "opencode-go") && api === "openai-completions") {
    return { supportsStore: false, supportsDeveloperRole: false };
  }
  return undefined;
}

/** Rule P3: the entry without tier is the base, each context tier becomes tiers[] with inputTokensAbove: size. */
export function costEntry(cost: readonly ModelCost[]): JsonObject {
  const base = cost.find((c) => c.tier === undefined)!;
  const rate = (c: ModelCost): JsonObject => ({ input: c.input, output: c.output, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0 });
  const tiered = cost.filter((c): c is ModelCost & { tier: { type: "context"; size: number } } => c.tier !== undefined);
  return { ...rate(base), ...(tiered.length > 0 ? { tiers: tiered.map((c) => ({ inputTokensAbove: c.tier.size, ...rate(c) })) } : {}) };
}

function modelEntry(model: DetailedModel, origin: string): JsonObject | undefined {
  // Rule P2: the reference's package format when the model accepts it, else its first format; no format: left out.
  const chosen = chooseFormat(model);
  if (chosen === undefined) return undefined;
  const route = PI_API[chosen.format];
  const thinking = piThinking(model, route.api);
  const compat: JsonObject = { ...thinking.compat, ...SUBSCRIPTION_COMPAT[model.provider], ...gatewayCompat(model, route.api) };
  // Rule P3: input restricted to the two modalities pi accepts.
  const input = model.input?.filter((m): m is "text" | "image" => m === "text" || m === "image");
  return {
    id: model.id,
    name: model.name,
    api: route.api,
    baseUrl: `${origin}${route.path}`,
    ...(input !== undefined && input.length > 0 ? { input: [...input] } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxTokens: model.maxOutputTokens } : {}),
    // Rule P5: the openai cell always reasons.
    reasoning: model.provider === "openai" ? true : thinking.reasoning,
    ...(thinking.thinkingLevelMap !== undefined ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
    ...(model.cost !== undefined ? { cost: costEntry(model.cost) } : {}),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
  };
}

export class PiConfigCodec extends PiConfigPort {
  config(catalogs: readonly DetailedCatalog[], at: ClientOrigin): JsonObject {
    const providers: JsonObject = {};
    for (const catalog of catalogs) {
      // Rule P1: a provider that could not list its models has nothing to configure.
      if (catalog.source === "unavailable") continue;
      const models: JsonObject[] = [];
      for (const model of catalog.models) {
        const entry = modelEntry(model, at.origin);
        if (entry !== undefined) models.push(entry);
      }
      providers[piProviderId(catalog.provider)] = {
        // Rule P1: the opencode display names, the token variable, no provider-level api or baseUrl.
        name: `AP · ${PROVIDER_DISPLAY_NAMES[catalog.provider]}`,
        apiKey: `$${TOKEN_VARIABLE}`,
        models,
      };
    }
    // Rule P7: the document passes pi 1.5.2's published schema.
    return { $schema: PI_SCHEMA_URL, providers };
  }

  manifest(at: ClientOrigin): JsonObject {
    return {
      auth: { command: [...at.tokenCommand], env: TOKEN_VARIABLE },
      config: { url: `${at.origin}${PI_CONFIG_PATH}` },
    };
  }
}
