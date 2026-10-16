// opencode v2's view of the router (plan 2026-10-16 C4, rules O1–O5): its provider configuration and the
// `/.well-known/opencode` manifest of `opencode auth login <origin>`. The dialect-opencode workspace implements it.
import type { JsonObject } from "@inference-router/core/domain/json.ts";
import type { DetailedCatalog } from "@inference-router/core/domain/model-details.ts";

/** Where the router answers and how opencode obtains its token. */
export type OpencodeOrigin = {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The command that prints the router token (`inference-router token`), absolute so opencode can spawn it anywhere. */
  readonly tokenCommand: readonly string[];
};

export abstract class OpencodeConfigPort {
  /** The configuration document: one opencode provider per catalog. */
  abstract config(catalogs: readonly DetailedCatalog[], at: OpencodeOrigin): JsonObject;
  /** The well-known manifest: the token command and the configuration URL. */
  abstract manifest(at: OpencodeOrigin): JsonObject;
}
