// A client dialect's own response shapes for what the router itself answers: errors and model lists. Each
// dialect workspace implements one; the HTTP adapter picks it by route prefix.
import type { RouterError } from "@inference-router/core/domain/errors.ts";
import type { Dialect, ModelCatalog } from "@inference-router/core/domain/models.ts";

export type EncodedResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export abstract class DialectCodecPort {
  abstract readonly dialect: Dialect;
  /** The route prefix, e.g. `/anthropic`. */
  abstract readonly prefix: string;
  abstract error(error: RouterError): EncodedResponse;
  abstract models(catalogs: readonly ModelCatalog[]): EncodedResponse;
}
