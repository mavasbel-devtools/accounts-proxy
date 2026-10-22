// Streaming HTTP client over the runtime's fetch (Bun 1.4.2). The response body is yielded chunk by chunk as it
// arrives; header names are lower-cased. `timeoutMs` aborts the whole exchange, body read included; `signal` aborts
// it when the proxy's client disconnects. The socket idle timeout is always explicit (`idleMs`, production value
// UPSTREAM_IDLE_TIMEOUT_MS) instead of Bun's own 5-minute default (bun-types globals.d.ts `timeout`, P0-LIVE L12).
// A timeout (whole-exchange or idle, before or during the body) is an UpstreamTimeoutError (504). Any other failure
// without an HTTP answer (DNS, refused, reset, TLS), before or during the body, is an UpstreamUnreachableError (502,
// plan v4 H5), except when the proxy's own client went away: that abort is passed through unchanged.
import { UpstreamTimeoutError, UpstreamUnreachableError } from "@accounts-proxy/core/domain/errors.ts";
import type { HttpRequest, HttpResponse } from "@accounts-proxy/core/domain/wire.ts";
import { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

/** The Bun-specific fetch option (`timeout`: socket idle deadline in ms) on top of the standard RequestInit. */
export type FetchInit = RequestInit & { readonly timeout?: number };
export type FetchFunction = (url: string, init: FetchInit) => Promise<Response>;

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

export class FetchTransport extends HttpTransportPort {
  constructor(
    private readonly fetchImpl: FetchFunction,
    /** Fail when the connection stays idle (no byte sent or received) this long (production: UPSTREAM_IDLE_TIMEOUT_MS). */
    private readonly idleMs: number,
  ) {
    super();
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const idleMs = this.idleMs;
    const limitMs = request.timeoutMs ?? idleMs;
    const signals = [request.signal, request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined].filter((s) => s !== undefined);
    const host = new URL(request.url).host;
    const failure = (error: unknown): unknown => {
      if (isTimeout(error)) return new UpstreamTimeoutError(host, limitMs);
      if (request.signal?.aborted === true) return error;
      return new UpstreamUnreachableError(host, String(error));
    };
    let res: Response;
    try {
      res = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers as FetchInit["headers"],
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: AbortSignal.any(signals),
        timeout: idleMs,
      });
    } catch (error) {
      throw failure(error);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: res.status, headers, body: bodyOf(res.body, failure) };
  }
}

async function* bodyOf(stream: ReadableStream<Uint8Array> | null, failure: (error: unknown) => unknown): AsyncIterable<Uint8Array> {
  if (stream === null) return;
  try {
    for await (const chunk of stream) yield chunk;
  } catch (error) {
    throw failure(error);
  }
}
