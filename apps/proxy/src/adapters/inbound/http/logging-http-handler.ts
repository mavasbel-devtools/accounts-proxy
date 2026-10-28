// Decorates the route table with the exchange log (plan 2026-10-26 X1–X2): the request body is recorded as the route
// reads it, the answer's chunks as they pass to the socket, and the response record is written when the body ends,
// is abandoned by the client, or fails. The routes run inside the exchange's scope, so their upstream calls name it.
import { headerPairs } from "@accounts-proxy/core/domain/exchange-log.ts";
import type { ClientExchangePort, ClientExchangeTrace } from "@accounts-proxy/core/ports/inbound/exchange-log.ts";
import { HttpHandler, type InboundRequest, type OutboundResponse } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";

export class LoggingHttpHandler extends HttpHandler {
  constructor(
    private readonly inner: HttpHandler,
    private readonly exchanges: ClientExchangePort,
  ) {
    super();
  }

  async handle(request: InboundRequest): Promise<OutboundResponse> {
    const trace = this.exchanges.begin({ method: request.method, path: request.path, query: request.query, headers: request.rawHeaders });
    const traced: InboundRequest = {
      ...request,
      readBody: async () => {
        try {
          const body = await request.readBody();
          trace.requestBody(body);
          return body;
        } catch (error) {
          trace.requestBody(undefined, String(error));
          throw error;
        }
      },
    };
    // The route table answers every error itself (RouteHandler), so a response always follows.
    const response = await trace.within(() => this.inner.handle(traced));
    trace.response(response.status, headerPairs(response.headers));
    return { ...response, body: recorded(response.body, trace, request.signal) };
  }
}

/** Each chunk is pulled inside the exchange's scope: a provider that calls upstream while streaming still names it. */
async function* recorded(body: AsyncIterable<Uint8Array>, trace: ClientExchangeTrace, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  let outcome: "complete" | "aborted" | "failed" = "aborted";
  let failure: string | undefined;
  try {
    for (;;) {
      const next = await trace.within(() => iterator.next());
      if (next.done === true) break;
      trace.chunk(next.value);
      yield next.value;
    }
    outcome = "complete";
  } catch (error) {
    outcome = "failed";
    failure = String(error);
    throw error;
  } finally {
    // A client that went away makes the exchange aborted, however the source ended.
    trace.end(signal.aborted ? "aborted" : outcome, failure);
    // The socket stopped reading (the generator was returned early): let the source release its upstream stream.
    if (outcome === "aborted") await iterator.return?.();
  }
}
