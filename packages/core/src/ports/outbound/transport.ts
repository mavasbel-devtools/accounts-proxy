import type { HttpRequest, HttpResponse } from "@accounts-proxy/core/domain/wire.ts";

/** Compresses a request body for the `content-encoding` that an upstream's own client sends. */
export abstract class ContentEncoderPort {
  /** The `content-encoding` value, e.g. `zstd`. */
  abstract readonly encoding: string;
  abstract encode(body: string): Uint8Array;
}

/** Streaming HTTP client. The response body is yielded as it arrives (never buffered by the transport). */
export abstract class HttpTransportPort {
  abstract send(request: HttpRequest): Promise<HttpResponse>;
}
