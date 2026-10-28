// The exchange log's file and scope (plan 2026-10-26 X1, X4–X6). One JSON line per entry in
// `<logs>/exchanges-YYYY-MM-DD.jsonl` (UTC day; file 0600, directory 0700), every credential value replaced first;
// at the first write of a day the day files older than the retention are deleted. Writing never throws (X6).
// The scope follows the asynchronous work of one client exchange (node:async_hooks AsyncLocalStorage).
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXCHANGE_LOG_SCHEMA, redactEntry, Redactor, type ExchangeEntry } from "@accounts-proxy/core/domain/exchange-log.ts";
import { ExchangeScopePort, ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import type { ClockPort, HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";

const DAY_FILE = /^exchanges-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The redaction fingerprint: the first 12 hex digits of the value's SHA-256 (X4). */
export function fingerprintOf(hash: HashPort): (value: string) => string {
  return (value) => [...hash.sha256(value).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One exchange-log line (without its newline) of an already redacted entry. */
export function exchangeLine(redacted: ExchangeEntry, now: number, pid: number): string {
  return JSON.stringify({ schema: EXCHANGE_LOG_SCHEMA, at: new Date(now).toISOString(), pid, ...redacted });
}

export class FileExchangeSink extends ExchangeSinkPort {
  private readonly redactor: Redactor;
  private prunedFor: string | undefined;

  constructor(
    private readonly directory: string,
    private readonly clock: ClockPort,
    hash: HashPort,
    /** Days of files kept, today included (proxy.yaml `exchangeLog.retentionDays`). */
    private readonly retentionDays: number,
    private readonly pid: number,
  ) {
    super();
    this.redactor = new Redactor(fingerprintOf(hash));
  }

  write(entry: ExchangeEntry): void {
    try {
      const now = this.clock.now();
      const day = dayOf(now);
      mkdirSync(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      if (this.prunedFor !== day) {
        this.prunedFor = day;
        this.prune(now);
      }
      appendFileSync(join(this.directory, `exchanges-${day}.jsonl`), `${exchangeLine(redactEntry(entry, this.redactor), now, this.pid)}\n`, { mode: PRIVATE_FILE_MODE });
    } catch {
      // the exchange log is best-effort by contract (X6)
    }
  }

  private prune(now: number): void {
    const oldestKept = dayOf(now - (this.retentionDays - 1) * DAY_MS);
    for (const name of readdirSync(this.directory)) {
      const day = DAY_FILE.exec(name)?.[1];
      if (day !== undefined && day < oldestKept) rmSync(join(this.directory, name), { force: true });
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
