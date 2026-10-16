// Gemini dialect: the proxy's own errors and the model list in Gemini's shapes.
//   errors  the Google envelope `{error:{code, message, status}}` (core google-error.ts: P0-LIVE L10 captures and
//           google.rpc.Code); an upstream body that already is one is passed through verbatim.
//   models  ListModels `{models:[Model]}` (docs/reference/specs/gemini-models.md §Model). `name` and `baseModelId` are
//           the routable `<provider>/<model>` (baseModelId is documented as "pass this to the generation request");
//           `version` is required and no catalog has one, so it is the provider id — a neutral marker, never an
//           invented version (decision Q5). Only Gemini-native providers (antigravity) list generateContent and
//           streamGenerateContent; the others list none (the proxy does not translate between formats).
import { errorHeaders, type ProxyError } from "@accounts-proxy/core/domain/errors.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import { googleErrorEnvelope } from "@accounts-proxy/core/domain/services/google-error.ts";
import { DialectCodecPort, type EncodedResponse } from "@accounts-proxy/core/ports/inbound/dialect.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export class GeminiCodec extends DialectCodecPort {
  readonly dialect = "gemini";
  readonly prefix = "/gemini";

  error(error: ProxyError): EncodedResponse {
    return {
      status: error.httpStatus,
      headers: errorHeaders(error),
      body: JSON.stringify(googleErrorEnvelope(error)),
    };
  }

  models(catalogs: readonly DetailedCatalog[]): EncodedResponse {
    const models = catalogs.flatMap((c) =>
      c.models.map((m) => {
        const id = m.id;
        return {
          name: `models/${id}`,
          baseModelId: id,
          version: c.provider,
          displayName: m.name,
          ...(m.contextWindow !== undefined ? { inputTokenLimit: m.contextWindow } : {}),
          ...(m.maxOutputTokens !== undefined ? { outputTokenLimit: m.maxOutputTokens } : {}),
          supportedGenerationMethods: m.formats.includes("gemini") ? ["generateContent", "streamGenerateContent"] : [],
        };
      }),
    );
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ models }) };
  }
}
