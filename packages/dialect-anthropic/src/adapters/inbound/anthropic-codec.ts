// Anthropic Messages dialect: the router's own errors and the model list in Anthropic's shapes.
//   errors  `{type:"error", error:{type, message}}`, `type` from the documented status table
//           (docs/reference/specs/anthropic-errors.md §HTTP errors); the table holds every 4xx status the router emits,
//           so a status outside it is a 5xx → api_error.
//   models  ListModels (anthropic-models-list.md §Returns): data[] of ModelInfo, first_id, has_more, last_id.
//           `created_at` is required; a catalog without dates (Antigravity) gets the neutral marker
//           1970-01-01T00:00:00Z, never an invented date (decision Q5).
import type { RouterError } from "@inference-router/core/domain/errors.ts";
import { formatModelAddress, type ModelCatalog } from "@inference-router/core/domain/models.ts";
import { DialectCodecPort, type EncodedResponse } from "@inference-router/core/ports/inbound/dialect.ts";

const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  504: "timeout_error",
  529: "overloaded_error",
};

export const UNDATED = "1970-01-01T00:00:00Z";

export function anthropicErrorType(status: number): string {
  return ERROR_TYPES[status] ?? "api_error";
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export class AnthropicCodec extends DialectCodecPort {
  readonly dialect = "anthropic";
  readonly prefix = "/anthropic";

  error(error: RouterError): EncodedResponse {
    return {
      status: error.httpStatus,
      headers: { ...JSON_HEADERS, ...(error.retryAfterSeconds !== undefined ? { "retry-after": String(error.retryAfterSeconds) } : {}) },
      body: JSON.stringify({ type: "error", error: { type: anthropicErrorType(error.httpStatus), message: error.message } }),
    };
  }

  models(catalogs: readonly ModelCatalog[]): EncodedResponse {
    const data = catalogs.flatMap((c) =>
      c.models.map((m) => ({
        type: "model",
        id: formatModelAddress(m.address),
        display_name: m.displayName,
        created_at: m.createdAt ?? UNDATED,
        max_input_tokens: m.contextWindow ?? null,
        max_tokens: m.maxOutputTokens ?? null,
        capabilities: null,
        line: null,
      })),
    );
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null }) };
  }
}
