// OpenCode Zen and Go rules (rules document 2026-10-12-15-35-gateway-provider-rules.md §3, Z1–Z11). Pure.
import { InvalidRequestError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId, WireFormat } from "@inference-router/core/domain/models.ts";
import { asObject, firstString, gatewayModel, positiveInteger, rowsWithId, type GatewayModel, type GatewaySpec } from "@inference-router/provider-gateway/domain/gateway.ts";

export type OpencodeProvider = Extract<ProviderId, "opencode" | "opencode-go">;

/** Z9: the gateway's request id response header. */
const LOG_ID = "x-opencode-log-id";

/** Z1–Z3: Zen serves Chat, Responses, Messages and Gemini (key header per endpoint). */
export const ZEN_SPEC: GatewaySpec = {
  provider: "opencode",
  apiBase: "https://opencode.ai/zen/v1",
  endpoints: {
    "openai-chat": { path: "/chat/completions", keyHeader: "authorization" },
    "openai-responses": { path: "/responses", keyHeader: "authorization" },
    "anthropic-messages": { path: "/messages", keyHeader: "x-api-key" },
    gemini: { path: "/models", keyHeader: "x-goog-api-key" },
  },
  requestIdHeader: LOG_ID,
};

/** Z1–Z3: Go serves Chat, Responses and Messages (no Gemini route). */
export const GO_SPEC: GatewaySpec = {
  provider: "opencode-go",
  apiBase: "https://opencode.ai/zen/go/v1",
  endpoints: {
    "openai-chat": { path: "/chat/completions", keyHeader: "authorization" },
    "openai-responses": { path: "/responses", keyHeader: "authorization" },
    "anthropic-messages": { path: "/messages", keyHeader: "x-api-key" },
  },
  requestIdHeader: LOG_ID,
};

export const MODELS_PATH = "/models";
/** Z11 */
export const GO_USAGE_PATH = "/usage";
/** Z5: per-model formats. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Z5: the AI SDK package of a model → its format. */
const NPM_FORMAT: ReadonlyMap<string, WireFormat> = new Map([
  ["@ai-sdk/openai", "openai-responses"],
  ["@ai-sdk/anthropic", "anthropic-messages"],
  ["@ai-sdk/google", "gemini"],
  ["@ai-sdk/openai-compatible", "openai-chat"],
  ["@ai-sdk/mistral", "openai-chat"],
]);

export type ModelsDevModel = { readonly name: string | undefined; readonly context: number | undefined; readonly output: number | undefined; readonly format: WireFormat | undefined };

/** Z5: the provider's models.dev entries by id (format from the per-model `provider.npm`, else the provider's `npm`). */
export function modelsDevEntries(value: unknown, provider: OpencodeProvider): ReadonlyMap<string, ModelsDevModel> {
  const entry = asObject(asObject(value)[provider]);
  return new Map(
    Object.entries(asObject(entry["models"])).map(([id, raw]) => {
      const model = asObject(raw);
      const limit = asObject(model["limit"]);
      const npm = firstString(asObject(model["provider"])["npm"], entry["npm"]);
      return [id, { name: firstString(model["name"]), context: positiveInteger(limit["context"]), output: positiveInteger(limit["output"]), format: NPM_FORMAT.get(String(npm)) }];
    }),
  );
}

/** Z4 + Z5: the gateway's live ids, described by models.dev where it knows them (others: formats unknown, Z6). */
export function opencodeModels(list: unknown, details: ReadonlyMap<string, ModelsDevModel>): GatewayModel[] {
  return rowsWithId(asObject(list)["data"]).map((row) => {
    const id = row["id"] as string;
    const d = details.get(id);
    return gatewayModel({ id, displayName: firstString(d?.name, id)!, contextWindow: d?.context, maxOutputTokens: d?.output, createdSeconds: undefined, formats: d?.format === undefined ? undefined : [d.format] });
  });
}

/** Z7: Console keys start `oc_sk_`; legacy keys `sk-`. Zen has no authenticated read endpoint to check a key with. */
export function checkKeyFormat(key: string): void {
  if (!key.startsWith("oc_sk_") && !key.startsWith("sk-")) throw new InvalidRequestError("an OpenCode API key starts with oc_sk_ (or sk- for a legacy key)");
}
