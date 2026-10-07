// Streaming HTTP client over the runtime's fetch (Bun 1.4.2). The response body is yielded chunk by chunk as it
// arrives; header names are lower-cased. `timeoutMs` aborts the whole exchange, body read included.
import type { HttpRequest, HttpResponse } from "@inference-router/core/domain/wire.ts";
import { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";

export class FetchTransport extends HttpTransportPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {
    super();
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const res = await this.fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.timeoutMs !== undefined ? { signal: AbortSignal.timeout(request.timeoutMs) } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: res.status, headers, body: bodyOf(res.body) };
  }
}

async function* bodyOf(stream: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (stream === null) return;
  for await (const chunk of stream) yield chunk;
}
