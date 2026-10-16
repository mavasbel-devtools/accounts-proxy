// OpenAI dialect: the router's own errors and the model list in OpenAI's shapes (docs/reference/specs/openai-openapi.yaml).
//   errors  ErrorResponse `{error:{message, type, param, code}}` (all four required). The spec fixes no vocabulary for
//           `type`/`code`, so both carry the router's own error code; `param` is null.
//   models  ListModelsResponse `{object:"list", data:[Model]}`, Model `{id, object:"model", created, owned_by}`.
//           `created` is Unix seconds; a catalog without dates (Antigravity) gets 0, never an invented date (Q5).
import { errorHeaders, type RouterError } from "@inference-router/core/domain/errors.ts";
import type { DetailedCatalog } from "@inference-router/core/domain/model-details.ts";
import { DialectCodecPort, type EncodedResponse } from "@inference-router/core/ports/inbound/dialect.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function unixSeconds(rfc3339: string | undefined): number {
  const ms = rfc3339 === undefined ? Number.NaN : Date.parse(rfc3339);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export class OpenAiCodec extends DialectCodecPort {
  readonly dialect = "openai";
  readonly prefix = "/openai";

  error(error: RouterError): EncodedResponse {
    return {
      status: error.httpStatus,
      headers: errorHeaders(error),
      body: JSON.stringify({ error: { message: error.message, type: error.code, param: null, code: error.code } }),
    };
  }

  models(catalogs: readonly DetailedCatalog[]): EncodedResponse {
    const data = catalogs.flatMap((c) => c.models.map((m) => ({ id: m.id, object: "model", created: unixSeconds(m.createdAt), owned_by: c.provider })));
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ object: "list", data }) };
  }
}
