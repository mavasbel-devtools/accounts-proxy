// The usage log's sink and scope (plan 2026-10-26 X4–X6, plan 2026-10-27-23-29 L2). One JSON line per entry, every
// credential value replaced first, handed to the process's usage log stream. Writing never throws (X6).
// The scope follows the asynchronous work of one client exchange (node:async_hooks AsyncLocalStorage).
import { AsyncLocalStorage } from "node:async_hooks";
import { EXCHANGE_LOG_SCHEMA, redactEntry, Redactor, type ExchangeEntry } from "@accounts-proxy/core/domain/exchange-log.ts";
import { ExchangeScopePort, ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import type { ClockPort, HashPort, LogStreamPort } from "@accounts-proxy/core/ports/outbound/system.ts";

/** The redaction fingerprint: the first 12 hex digits of the value's SHA-256 (X4). */
export function fingerprintOf(hash: HashPort): (value: string) => string {
  return (value) => [...hash.sha256(value).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One exchange-log line (without its newline) of an already redacted entry. */
export function exchangeLine(redacted: ExchangeEntry, now: number, pid: number): string {
  return JSON.stringify({ schema: EXCHANGE_LOG_SCHEMA, at: new Date(now).toISOString(), pid, ...redacted });
}

export class StreamExchangeSink extends ExchangeSinkPort {
  private readonly redactor: Redactor;

  constructor(
    private readonly stream: LogStreamPort,
    private readonly clock: ClockPort,
    hash: HashPort,
    private readonly pid: number,
  ) {
    super();
    this.redactor = new Redactor(fingerprintOf(hash));
  }

  write(entry: ExchangeEntry): void {
    try {
      this.stream.line(exchangeLine(redactEntry(entry, this.redactor), this.clock.now(), this.pid));
    } catch {
      // the usage log is best-effort by contract (X6)
    }
  }
}

export class AsyncExchangeScope extends ExchangeScopePort {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(exchange: string, work: () => Promise<T>): Promise<T> {
    return this.storage.run(exchange, work);
  }

  current(): string | undefined {
    return this.storage.getStore();
  }
}
