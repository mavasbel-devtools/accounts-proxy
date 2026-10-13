// Cheaper Inference rules (rules document 2026-10-12-15-35-gateway-provider-rules.md §4, C1–C9). Pure.
import type { WireFormat } from "@inference-router/core/domain/models.ts";
import { asArray, asObject, fieldsText, firstString, gatewayModel, positiveInteger, rowsWithId, type GatewayModel, type GatewaySpec } from "@inference-router/provider-gateway/domain/gateway.ts";

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
    return formats.length === 0 ? [] : [gatewayModel({ id, displayName: id, contextWindow: positiveInteger(row["context_length"]), maxOutputTokens: positiveInteger(row["max_output_tokens"]), createdSeconds: undefined, formats })];
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
