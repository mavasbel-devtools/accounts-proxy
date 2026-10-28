// Inbound port of the exchange log: the daemon's HTTP adapter reports each client exchange through it (plan 2026-10-26 X1–X2).
import type { RecordedHeaders } from "@accounts-proxy/core/domain/exchange-log.ts";

export type ClientRequestStart = {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** As the client sent them (order and case). */
  readonly headers: RecordedHeaders;
};

/** One client exchange being recorded. The request record is written once, the response record when the body ends. */
export abstract class ClientExchangeTrace {
  abstract readonly id: string;
  /** Runs `work` as part of this exchange (upstream calls made meanwhile name it). */
  abstract within<T>(work: () => Promise<T>): Promise<T>;
  /** The request body was read (or failed to be read); writes the request record. */
  abstract requestBody(body: string | undefined, error?: string): void;
  /** The answer's status and headers; writes the request record if the body was never read. */
  abstract response(status: number, headers: RecordedHeaders): void;
  abstract chunk(bytes: Uint8Array): void;
  /** Writes the response record. */
  abstract end(outcome: "complete" | "aborted" | "failed", error?: string): void;
}

export abstract class ClientExchangePort {
  abstract begin(request: ClientRequestStart): ClientExchangeTrace;
}
