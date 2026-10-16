// Cheaper Inference rules (rules document 2026-10-12-15-35-gateway-provider-rules.md §4, C1–C9). Pure.
import { compactDetails, perMillion, type Modality, type ModelCost, type ModelDetails } from "@accounts-proxy/core/domain/model-details.ts";
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { asArray, asObject, fieldsText, firstString, gatewayModel, positiveInteger, rowsWithId, type GatewayModel, type GatewaySpec } from "@accounts-proxy/provider-gateway/domain/gateway.ts";

export const API_ORIGIN = "https://api.cheaperinference.com";

/** C1–C2, C8: bearer key on every endpoint; Chat, Responses, Messages and count_tokens. */
export const CHEAPER_SPEC: GatewaySpec = {
  provider: "cheaper-inference",
  apiBase: `${API_ORIGIN}/v1`,
  endpoints: {
    "openai-chat": { path: "/chat/completions" },
    "openai-responses": { path: "/responses" },
    "anthropic-messages": { path: "/messages" },
  },
  countTokens: { path: "/messages/count_tokens" },
  requestIdHeader: "x-ci-request-id",
};

/** C3 */
export const MODELS_PATH = "/models";
/** C4 */
export const PUBLIC_MODELS_URL = `${API_ORIGIN}/public/models`;
/** C6 */
export const ACCOUNT_PATH = "/account";
/** C7 */
export const BALANCE_PATH = "/account/balance";

/** C3: the endpoint a model lists → its format (legacy `/v1/completions` and the media endpoints have none). */
const ENDPOINT_FORMAT: ReadonlyMap<unknown, WireFormat> = new Map([
  ["/v1/chat/completions", "openai-chat"],
  ["/v1/responses", "openai-responses"],
  ["/v1/messages", "anthropic-messages"],
]);

/** Prices are USD per million tokens as decimal strings; the above-threshold prices are a context tier. */
function pricing(row: Readonly<Record<string, unknown>>): ModelCost[] | undefined {
  const input = perMillion(row["input_per_million"], "million");
  const output = perMillion(row["output_per_million"], "million");
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = perMillion(row["cache_read_per_million"], "million");
  const cacheWrite = perMillion(row["cache_write_per_million"], "million");
  const base: ModelCost = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  const size = positiveInteger(row["input_token_price_threshold"]);
  const above = { input: perMillion(row["input_per_million_above_threshold"], "million"), output: perMillion(row["output_per_million_above_threshold"], "million") };
  if (size === undefined || above.input === undefined || above.output === undefined) return [base];
  return [base, { input: above.input, output: above.output, tier: { type: "context", size } }];
}

/** Plan 2026-10-16 C3: a text model (`model_type: "text"`) reads text and writes text; `supports_*` add media. */
function details(row: Readonly<Record<string, unknown>>): ModelDetails | undefined {
  const text = row["model_type"] === "text";
  const input: Modality[] = [...(text ? ["text" as const] : []), ...(row["supports_vision"] === true ? ["image" as const] : []), ...(row["supports_video"] === true ? ["video" as const] : [])];
  return compactDetails({
    description: undefined,
    family: undefined,
    releaseDate: undefined,
    knowledge: undefined,
    status: undefined,
    inputLimit: undefined,
    input: input.length > 0 ? input : undefined,
    output: text ? ["text"] : undefined,
    toolCall: undefined,
    structuredOutput: undefined,
    temperature: undefined,
    reasoning: typeof row["supports_reasoning"] === "boolean" ? row["supports_reasoning"] : undefined,
    reasoningOptions: undefined,
    interleavedField: undefined,
    openWeights: undefined,
    aiSdkPackage: undefined,
    cost: pricing(row),
  });
}

/**
 * C3/C4: `data[]` of `GET /v1/models` or `models[]` of `GET /public/models`; a model's endpoints are its `endpoint` and
 * its `supported_endpoints`. A model is a text model when it lists at least one text endpoint; media-only models are
 * left out (they are not served on these routes, [endpoint-formats]).
 */
export function parseModels(value: unknown): GatewayModel[] {
  const list = asObject(value);
  return [...rowsWithId(list["data"]), ...rowsWithId(list["models"])].flatMap((row) => {
    const endpoints = [row["endpoint"], ...asArray(row["supported_endpoints"])];
    const formats = [...new Set(endpoints.flatMap((e) => [ENDPOINT_FORMAT.get(e)]).filter((f): f is WireFormat => f !== undefined))];
    const id = row["id"] as string;
    return formats.length === 0 ? [] : [gatewayModel({ id, displayName: id, contextWindow: positiveInteger(row["context_length"]), maxOutputTokens: positiveInteger(row["max_output_tokens"]), createdSeconds: undefined, formats, details: details(row) })];
  });
}

/** C6: the account behind a key (`email` is the identity, `workspace_name` the label). */
export function parseAccount(value: unknown): { readonly id: string | undefined; readonly label: string | undefined } {
  const account = asObject(value);
  return { id: firstString(account["email"]), label: firstString(account["workspace_name"], account["email"]) };
}

/** C7: the wallet fields `quota cheaper-inference` prints, as Cheaper Inference states them. */
const BALANCE_FIELDS = ["currency", "balance_usd", "available_usd", "reserved_usd"];

export function balanceText(value: unknown): string {
  return fieldsText("Cheaper Inference wallet (GET /v1/account/balance):", asObject(value), BALANCE_FIELDS);
}
