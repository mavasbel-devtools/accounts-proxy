// Where the proxy's pi configuration lives (architecture design §5): the /.well-known/pi manifest and the document it points at.
// No workspace dependencies (package.json): the extension runs inside pi's Node.js process, so JSON stays structural here.
/** A JSON value. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** The well-known manifest: how to obtain a token and where the models document lives. */
export type PiManifest = {
  readonly auth: { readonly command: readonly string[]; readonly env: string };
  readonly config: { readonly url: string };
};

export abstract class ProxyDiscoveryPort {
  /** GET the well-known manifest from the proxy. */
  abstract manifest(): Promise<PiManifest>;
  /** GET the pi models.json document at url with the Bearer token. */
  abstract config(url: string, token: string): Promise<JsonObject>;
}
