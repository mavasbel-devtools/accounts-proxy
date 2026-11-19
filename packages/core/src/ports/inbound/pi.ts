// pi's view of the proxy (plan 2026-11-15-23-52, rules P1–P7): its models.json document and the /.well-known/pi manifest. The dialect-pi workspace implements it.
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";

export abstract class PiConfigPort {
  /** The pi models.json document: one ap-<provider> entry per catalog. */
  abstract config(catalogs: readonly DetailedCatalog[], at: ClientOrigin): JsonObject;
  /** The well-known manifest: the token command and the models document URL. */
  abstract manifest(at: ClientOrigin): JsonObject;
}
