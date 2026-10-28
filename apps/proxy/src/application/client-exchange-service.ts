// Records the client side of every daemon exchange (plan 2026-10-26 X1–X3): the request record (method, path, query,
// headers as sent, whole body) once the body is read, the response record (status, headers, whole body with each
// chunk's time and size, the stated token usage, timings and outcome) when the body ends.
import { BodyRecorder, recordBody, tokenUsage, type RecordedHeaders } from "@accounts-proxy/core/domain/exchange-log.ts";
import { ClientExchangePort, ClientExchangeTrace, type ClientRequestStart } from "@accounts-proxy/core/ports/inbound/exchange-log.ts";
import type { ExchangeScopePort, ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import type { ClockPort, RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export class ClientExchangeService extends ClientExchangePort {
  constructor(
    private readonly sink: ExchangeSinkPort,
    private readonly scope: ExchangeScopePort,
    private readonly clock: ClockPort,
    private readonly random: RandomPort,
  ) {
    super();
  }

  begin(request: ClientRequestStart): ClientExchangeTrace {
    return new RecordedClientExchange(this.sink, this.scope, this.clock, `c-${this.random.uuid()}`, request);
  }
}

class RecordedClientExchange extends ClientExchangeTrace {
  private readonly startedAt: number;
  private requestWritten = false;
  private bodyReadAt: number | undefined;
  private status: number | undefined;
  private headers: RecordedHeaders = [];
  // Set by `response`, which the HTTP decorator always calls before `end`.
  private headersAt = 0;
  private readonly recorder: BodyRecorder;

  constructor(
    private readonly sink: ExchangeSinkPort,
    private readonly scope: ExchangeScopePort,
    private readonly clock: ClockPort,
    readonly id: string,
    private readonly request: ClientRequestStart,
  ) {
    super();
    this.startedAt = clock.now();
    this.recorder = new BodyRecorder(this.startedAt);
  }

  within<T>(work: () => Promise<T>): Promise<T> {
    return this.scope.run(this.id, work);
  }

  requestBody(body: string | undefined, error?: string): void {
    this.bodyReadAt = this.clock.now();
    this.writeRequest(body, error);
  }

  response(status: number, headers: RecordedHeaders): void {
    this.writeRequest(undefined);
    this.status = status;
    this.headers = headers;
    this.headersAt = this.clock.now();
  }

  chunk(bytes: Uint8Array): void {
    this.recorder.add(bytes, this.clock.now());
  }

  end(outcome: "complete" | "aborted" | "failed", error?: string): void {
    const endedAt = this.clock.now();
    const body = this.recorder.body();
    // Base64 text (a binary answer) is neither JSON nor `data:` lines, so it states no usage.
    const usage = tokenUsage(body.text);
    this.sink.write({
      kind: "client-response",
      id: this.id,
      status: this.status,
      headers: this.headers,
      body,
      chunks: this.recorder.chunks,
      ...(usage !== undefined ? { usage } : {}),
      outcome,
      ...(error !== undefined ? { error } : {}),
      timing: {
        startedAt: new Date(this.startedAt).toISOString(),
        ...(this.bodyReadAt !== undefined ? { requestBodyMs: this.bodyReadAt - this.startedAt } : {}),
        headersMs: this.headersAt - this.startedAt,
        ...(this.recorder.firstByteAfterMs !== undefined ? { firstByteMs: this.recorder.firstByteAfterMs } : {}),
        totalMs: endedAt - this.startedAt,
      },
    });
  }

  private writeRequest(body: string | undefined, error?: string): void {
    if (this.requestWritten) return;
    this.requestWritten = true;
    this.sink.write({
      kind: "client-request",
      id: this.id,
      startedAt: new Date(this.startedAt).toISOString(),
      method: this.request.method,
      path: this.request.path,
      query: this.request.query,
      headers: this.request.headers,
      body: recordBody(body),
      ...(error !== undefined ? { error } : {}),
    });
  }
}
