// A recording decorator over the production HttpTransportPort: every exchange keeps the outbound request exactly as
// sent and every response chunk with a monotonic arrival time (ms since the request was sent), which is the proof of
// incremental streaming. Nothing is redacted here; the capture writer redacts before anything touches the disk.
import type { HttpRequest, HttpResponse } from "@accounts-proxy/core/domain/wire.ts";
import { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

export type RecordedChunk = { readonly atMs: number; readonly text: string };
export type Exchange = {
  readonly request: HttpRequest;
  status?: number;
  responseHeaders?: Readonly<Record<string, string>>;
  headersAtMs?: number;
  readonly chunks: RecordedChunk[];
  doneAtMs?: number;
  error?: string;
};

export class RecordingTransport extends HttpTransportPort {
  readonly exchanges: Exchange[] = [];

  constructor(
    private readonly inner: HttpTransportPort,
    private readonly now: () => number = () => performance.now(),
  ) {
    super();
  }

  /** Exchanges recorded since `mark` (an index returned by `mark()`). */
  mark(): number {
    return this.exchanges.length;
  }

  since(mark: number): Exchange[] {
    return this.exchanges.slice(mark);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const exchange: Exchange = { request, chunks: [] };
    this.exchanges.push(exchange);
    const start = this.now();
    let response: HttpResponse;
    try {
      response = await this.inner.send(request);
    } catch (error) {
      exchange.error = String(error);
      throw error;
    }
    exchange.status = response.status;
    exchange.responseHeaders = response.headers;
    exchange.headersAtMs = this.now() - start;
    return { status: response.status, headers: response.headers, body: this.tap(response.body, exchange, start) };
  }

  private async *tap(body: AsyncIterable<Uint8Array>, exchange: Exchange, start: number): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        exchange.chunks.push({ atMs: this.now() - start, text: decoder.decode(chunk, { stream: true }) });
        yield chunk;
      }
      const tail = decoder.decode();
      if (tail.length > 0) exchange.chunks.push({ atMs: this.now() - start, text: tail });
    } catch (error) {
      exchange.error = String(error);
      throw error;
    } finally {
      exchange.doneAtMs = this.now() - start;
    }
  }
}
