// The transport-neutral HTTP exchange between the socket server and the route table (so routing is testable
// without sockets and the server without routes).

export type InboundRequest = {
  readonly method: string;
  /** Raw path, percent-encoding preserved (a Gemini model segment may carry `%2F`). */
  readonly path: string;
  /** Decoded query parameters. */
  readonly query: Readonly<Record<string, string>>;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The headers as the client sent them: order, case and repeats kept (the exchange log records these). */
  readonly rawHeaders: readonly (readonly [string, string])[];
  /** The body as UTF-8 text; rejects with PayloadTooLargeError past the server's limit. */
  readBody(): Promise<string>;
  /** Aborted when the client disconnects before the response is complete. */
  readonly signal: AbortSignal;
};

export type OutboundResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
};

export abstract class HttpHandler {
  /** Never rejects: every failure is answered in the route's dialect. */
  abstract handle(request: InboundRequest): Promise<OutboundResponse>;
}
