// Gemini dialect: the router's own errors and the model list in Gemini's shapes.
//   errors  the Google envelope `{error:{code, message, status}}` (core google-error.ts: P0-LIVE L10 captures and
//           google.rpc.Code); an upstream body that already is one is passed through verbatim.
//   models  ListModels `{models:[Model]}` (docs/reference/specs/gemini-models.md §Model). `name` and `baseModelId` are
//           the routable `<provider>/<model>` (baseModelId is documented as "pass this to the generation request");
//           `version` is required and no catalog has one, so it is the provider id — a neutral marker, never an
//           invented version (decision Q5). Only Gemini-native providers (antigravity) list generateContent and
//           streamGenerateContent in P4; the others list none until the translated cells (P5).
import type { RouterError } from "@inference-router/core/domain/errors.ts";
import { formatModelAddress, modelFormats, type ModelCatalog } from "@inference-router/core/domain/models.ts";
import { googleErrorEnvelope } from "@inference-router/core/domain/services/google-error.ts";
import { DialectCodecPort, type EncodedResponse } from "@inference-router/core/ports/inbound/dialect.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export class GeminiCodec extends DialectCodecPort {
  readonly dialect = "gemini";
  readonly prefix = "/gemini";

  error(error: RouterError): EncodedResponse {
    return {
      status: error.httpStatus,
      headers: { ...JSON_HEADERS, ...(error.retryAfterSeconds !== undefined ? { "retry-after": String(error.retryAfterSeconds) } : {}) },
      body: JSON.stringify(googleErrorEnvelope(error)),
    };
  }

  models(catalogs: readonly ModelCatalog[]): EncodedResponse {
    const models = catalogs.flatMap((c) =>
      c.models.map((m) => {
        const id = formatModelAddress(m.address);
        return {
          name: `models/${id}`,
          baseModelId: id,
          version: c.provider,
          displayName: m.displayName,
          ...(m.contextWindow !== undefined ? { inputTokenLimit: m.contextWindow } : {}),
          ...(m.maxOutputTokens !== undefined ? { outputTokenLimit: m.maxOutputTokens } : {}),
          supportedGenerationMethods: modelFormats(c, m).includes("gemini") ? ["generateContent", "streamGenerateContent"] : [],
        };
      }),
    );
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ models }) };
  }
}
