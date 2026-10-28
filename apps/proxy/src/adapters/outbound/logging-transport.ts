// Decorates the upstream transport with the exchange log (plan 2026-10-26 X1–X3): every request the proxy sends — model
// calls, token renewals, logins, model lists, quota, the reference catalog — is recorded before it is sent (method, URL,
// headers in the order sent, the whole body, decoded too when it is compressed), and its answer when the body ends,
// is abandoned, or the call fails: status, headers, the whole body with each chunk's time and size, the stated token
// usage, timings and the outcome. Each names the client exchange it was made for.
import { BodyRecorder, headerPairs, recordBody, tokenUsage } from "@accounts-proxy/core/domain/exchange-log.ts";
import type { HttpRequest, HttpResponse } from "@accounts-proxy/core/domain/wire.ts";
import type { ExchangeScopePort, ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import type { ClockPort, RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { HttpTransportPort, type ContentDecoderPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

type Outcome = "complete" | "aborted" | "failed";

export class LoggingTransport extends HttpTransportPort {
  constructor(
    private readonly inner: HttpTransportPort,
    private readonly sink: ExchangeSinkPort,
    private readonly scope: ExchangeScopePort,
    private readonly clock: ClockPort,
    private readonly random: RandomPort,
    private readonly decoder: ContentDecoderPort,
  ) {
    super();
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const id = `u-${this.random.uuid()}`;
    const exchange = this.scope.current();
    const link = exchange !== undefined ? { exchange } : {};
    const startedAt = this.clock.now();
    const headers = headerPairs(request.headers);
    const encoding = headers.find(([name]) => name.toLowerCase() === "content-encoding")?.[1];
    const decoded = encoding !== undefined && encoding.toLowerCase() === this.decoder.encoding && request.body instanceof Uint8Array ? this.decoder.decode(request.body) : undefined;
    this.sink.write({
      kind: "upstream-request",
      id,
      ...link,
      startedAt: new Date(startedAt).toISOString(),
      method: request.method,
      url: request.url,
      headers,
      body: recordBody(request.body),
      // The text of a body the proxy compressed (opencode's zstd ChatGPT requests, recon gap P1).
      ...(decoded !== undefined ? { decodedBody: decoded } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
    const timing = (extra: Record<string, number>) => ({ startedAt: new Date(startedAt).toISOString(), ...extra, totalMs: this.clock.now() - startedAt });
    let response: HttpResponse;
    try {
      response = await this.inner.send(request);
    } catch (error) {
      this.sink.write({ kind: "upstream-response", id, ...link, outcome: "failed", error: String(error), timing: timing({}) });
      throw error;
    }
    const headersMs = this.clock.now() - startedAt;
    const recorder = new BodyRecorder(startedAt);
    const finish = (outcome: Outcome, error?: string): void => {
      const body = recorder.body();
      // Base64 text (a binary answer) is neither JSON nor `data:` lines, so it states no usage.
      const usage = tokenUsage(body.text);
      this.sink.write({
        kind: "upstream-response",
        id,
        ...link,
        status: response.status,
        headers: headerPairs(response.headers),
        body,
        chunks: recorder.chunks,
        ...(usage !== undefined ? { usage } : {}),
        outcome,
        ...(error !== undefined ? { error } : {}),
        timing: timing({ headersMs, ...(recorder.firstByteAfterMs !== undefined ? { firstByteMs: recorder.firstByteAfterMs } : {}) }),
      });
    };
    return { ...response, body: this.recorded(response.body, recorder, finish) };
  }

  private async *recorded(body: AsyncIterable<Uint8Array>, recorder: BodyRecorder, finish: (outcome: Outcome, error?: string) => void): AsyncIterable<Uint8Array> {
    let outcome: Outcome = "aborted";
    let failure: string | undefined;
    try {
      for await (const chunk of body) {
        recorder.add(chunk, this.clock.now());
        yield chunk;
      }
      outcome = "complete";
    } catch (error) {
      outcome = "failed";
      failure = String(error);
      throw error;
    } finally {
      finish(outcome, failure);
    }
  }
}
