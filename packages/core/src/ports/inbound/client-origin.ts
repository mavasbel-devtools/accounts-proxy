/** Where the proxy answers and how a client (opencode, pi) obtains its token. */
export type ClientOrigin = {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The command that prints the proxy token (`accounts-proxy token`), absolute so the client can spawn it anywhere. */
  readonly tokenCommand: readonly string[];
};
