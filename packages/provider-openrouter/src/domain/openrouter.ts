// OpenRouter rules (rules document 2026-10-12-15-35-gateway-provider-rules.md §2, R1–R10). Pure.
import { asObject, fieldsText, firstString, gatewayModel, positiveInteger, rowsWithId, type GatewayModel, type GatewaySpec } from "@inference-router/provider-gateway/domain/gateway.ts";

export const API_BASE = "https://openrouter.ai/api/v1";
/** R5: the browser page of the PKCE login. */
export const AUTH_URL = "https://openrouter.ai/auth";
/** R5: localhost callbacks on any port. */
export const CALLBACK_PATH = "/callback";
/** R7 */
export const KEYS_PATH = "/auth/keys";
/** R8 */
export const KEY_PATH = "/key";
/** R4 */
export const MODELS_PATH = "/models";
/** R6: prefills the label of the key the login creates. */
export const KEY_LABEL = "inference-router";
/**
 * The router's internal marker for the headless login (R6): never sent; it makes the authorization URL omit
 * `callback_url` and `state`, so the page shows the code to paste.
 */
export const HEADLESS_REDIRECT = "urn:inference-router:openrouter:headless";

/** R1–R3: bearer key on every endpoint; Chat, Responses and Messages for every model; no count_tokens. */
export const OPENROUTER_SPEC: GatewaySpec = {
  provider: "openrouter",
  apiBase: API_BASE,
  endpoints: {
    "openai-chat": { path: "/chat/completions" },
    "openai-responses": { path: "/responses" },
    "anthropic-messages": { path: "/messages" },
  },
  uniformFormats: ["openai-chat", "openai-responses", "anthropic-messages"],
  /** `openrouter-streaming.md`: "The generation ID is returned in the `X-Generation-Id` response header for all endpoints". */
  requestIdHeader: "x-generation-id",
};

/** R5/R6: the PKCE authorization URL (S256); the headless variant has no callback and no state. */
export function authorizeUrl(authUrl: string, redirectUri: string, state: string, codeChallenge: string): string {
  const url = new URL(authUrl);
  if (redirectUri !== HEADLESS_REDIRECT) url.searchParams.set("callback_url", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (redirectUri !== HEADLESS_REDIRECT) url.searchParams.set("state", state);
  else url.searchParams.set("key_label", KEY_LABEL);
  return url.toString();
}

/** R7: `{key, user_id}` of the code exchange (a missing field reads as absent; the caller checks the key). */
export function parseKeyExchange(value: unknown): { readonly key: string; readonly userId: string | undefined } {
  const answer = asObject(value);
  // `[x].join("")` is "" for an absent key, which the caller refuses (normalizeApiKey).
  return { key: [firstString(answer["key"])].join(""), userId: firstString(answer["user_id"]) };
}

/** R4: `data[]` of `GET /models`. */
export function parseModels(value: unknown): GatewayModel[] {
  return rowsWithId(asObject(value)["data"]).map((row) =>
    gatewayModel({
      id: row["id"] as string,
      displayName: firstString(row["name"], row["id"])!,
      contextWindow: positiveInteger(row["context_length"]),
      maxOutputTokens: positiveInteger(asObject(row["top_provider"])["max_completion_tokens"]),
      createdSeconds: positiveInteger(row["created"]),
      formats: undefined,
    }),
  );
}

/** R8: the `GET /key` fields `quota openrouter` prints (USD amounts as OpenRouter states them). */
const KEY_FIELDS = ["label", "is_free_tier", "usage", "usage_daily", "usage_weekly", "usage_monthly", "limit", "limit_remaining", "limit_reset"];

export function keyUsageText(value: unknown): string {
  return fieldsText("OpenRouter key (GET /key):", asObject(asObject(value)["data"]), KEY_FIELDS);
}
