import type { HttpRequest, HttpResponse } from "../../domain/wire.ts";

/** Streaming HTTP client. The response body is yielded as it arrives (never buffered by the transport). */
export abstract class HttpTransportPort {
  abstract send(request: HttpRequest): Promise<HttpResponse>;
}
