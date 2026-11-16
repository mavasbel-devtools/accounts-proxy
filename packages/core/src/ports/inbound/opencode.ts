// opencode v2's view of the proxy (plan 2026-10-16 C4, rules O1–O5): its provider configuration and the
// `/.well-known/opencode` manifest of `opencode auth login <origin>`. The dialect-opencode workspace implements it.
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";

export abstract class OpencodeConfigPort {
  /** The configuration document: one opencode provider per catalog. */
  abstract config(catalogs: readonly DetailedCatalog[], at: ClientOrigin): JsonObject;
  /** The well-known manifest: the token command and the configuration URL. */
  abstract manifest(at: ClientOrigin): JsonObject;
}
