// The native Responses cell (rules I2–I4, E2–E3; decisions O7, O8).
//   - prepareRequest: the client's Responses body → the upstream body. `store: false` and `stream: true` are always sent
//     (I2). A documented unsupported field, tool or system-role input item is 400 unsupported_feature, or is dropped
//     with `x-router-lossy: 1` (O7). A string `input` becomes the equivalent one user message (openai-openapi.yaml
//     `input`: "A text input to the model, equivalent to a text input with the `user` role"), because this route takes
//     `input` as an array (I2). A null field is the API's "not set" and is left out.
//   - aggregate: for a client that did not ask for a stream, the upstream event stream becomes one response (O8): the
//     `response` of `response.completed` or `response.incomplete`; `response.failed` and `error` events become an error
//     answer with the status of the documented code (E2), else 502; a stream without a terminal event is 502 (I2).
import { InvalidRequestError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "@inference-router/core/domain/json.ts";
import { SHARING_ERROR_STATUS, UNSUPPORTED_FIELDS, UNSUPPORTED_TOOL_TYPES } from "@inference-router/provider-openai/domain/constants.ts";

export const TARGET = "openai (ChatGPT plan usage)";

export type PreparedRequest = { readonly body: JsonObject; readonly clientStream: boolean; readonly dropped: readonly string[] };

const isSystemItem = (item: JsonValue) => isJsonObject(item) && (item["type"] === undefined || item["type"] === "message") && item["role"] === "system";
const unsupportedTool = (tool: JsonValue) => isJsonObject(tool) && typeof tool["type"] === "string" && UNSUPPORTED_TOOL_TYPES.includes(tool["type"]);

export function prepareRequest(client: JsonObject, model: string, lossy: boolean): PreparedRequest {
  const body: JsonObject = {};
  for (const [key, value] of Object.entries(client)) if (value !== null) body[key] = value;
  const stream = body["stream"];
  if (stream !== undefined && typeof stream !== "boolean") throw new InvalidRequestError("stream must be a boolean");
  const features: string[] = [];

  for (const field of UNSUPPORTED_FIELDS) {
    if (body[field] === undefined) continue;
    features.push(field);
    delete body[field];
  }
  if (body["store"] !== undefined && body["store"] !== false) {
    features.push("store");
  }

  const input = body["input"];
  let items: JsonValue[];
  if (typeof input === "string") items = [{ role: "user", content: input }];
  else if (Array.isArray(input)) items = input;
  else throw new InvalidRequestError("input must be a string or an array of input items");
  if (items.some(isSystemItem)) {
    features.push("input.system_message");
    items = items.filter((item) => !isSystemItem(item));
  }

  const tools = body["tools"];
  if (Array.isArray(tools)) {
    const rejected = tools.filter(unsupportedTool);
    for (const tool of rejected) features.push(`tools.${String((tool as JsonObject)["type"])}`);
    if (rejected.length > 0) body["tools"] = tools.filter((tool) => !unsupportedTool(tool));
  }
  const choice = body["tool_choice"];
  if (unsupportedTool(choice as JsonValue)) {
    features.push(`tool_choice.${String((choice as JsonObject)["type"])}`);
    delete body["tool_choice"];
  }

  const dropped = [...new Set(features)];
  if (dropped.length > 0 && !lossy) throw new UnsupportedFeatureError(dropped, TARGET);
  return { body: { ...body, model, input: items, store: false, stream: true }, clientStream: stream === true, dropped };
}

export type Aggregated = { readonly kind: "response"; readonly response: JsonObject } | { readonly kind: "error"; readonly status: number; readonly body: JsonObject };

function failure(error: JsonValue | undefined, fallback: string): Aggregated {
  const e = isJsonObject(error) ? error : {};
  const code = typeof e["code"] === "string" ? e["code"] : null;
  const message = typeof e["message"] === "string" ? e["message"] : fallback;
  const status = code !== null && Object.hasOwn(SHARING_ERROR_STATUS, code) ? SHARING_ERROR_STATUS[code]! : 502;
  return { kind: "error", status, body: { error: { message, type: "response_failed", param: e["param"] ?? null, code } } };
}

/** O8: the terminal event of the upstream stream decides the single answer. */
export function aggregate(events: readonly JsonObject[]): Aggregated {
  for (const event of events) {
    const type = event["type"];
    if ((type === "response.completed" || type === "response.incomplete") && isJsonObject(event["response"])) return { kind: "response", response: event["response"] };
    if (type === "response.failed") return failure(isJsonObject(event["response"]) ? event["response"]["error"] : undefined, "the response failed");
    if (type === "error") return failure(event, "the stream reported an error");
  }
  return { kind: "error", status: 502, body: { error: { message: "upstream stream ended without response.completed", type: "upstream_error", param: null, code: null } } };
}
