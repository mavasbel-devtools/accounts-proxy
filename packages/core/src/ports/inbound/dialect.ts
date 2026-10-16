// A client dialect's own response shapes for what the proxy itself answers: errors and model lists. Each
// dialect workspace implements one; the HTTP adapter picks it by route prefix.
import type { ProxyError } from "@accounts-proxy/core/domain/errors.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { Dialect } from "@accounts-proxy/core/domain/models.ts";

export type EncodedResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export abstract class DialectCodecPort {
  abstract readonly dialect: Dialect;
  /** The route prefix, e.g. `/anthropic`. */
  abstract readonly prefix: string;
  abstract error(error: ProxyError): EncodedResponse;
  /** The detailed catalogs (plan 2026-10-16 C2) in the dialect's model-list shape. */
  abstract models(catalogs: readonly DetailedCatalog[]): EncodedResponse;
}
