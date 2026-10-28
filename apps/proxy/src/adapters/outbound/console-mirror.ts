// The daemon's console output (plan 2026-10-27 C1): `serve` prints every log line (as proxy.log has it) and every
// exchange record (as the exchange log has it, credentials replaced first), each on its own line of stdout. Commands
// other than `serve` never start the mirror, so their output stays what scripts read.
import { redactEntry, Redactor, type ExchangeEntry } from "@accounts-proxy/core/domain/exchange-log.ts";
import { ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import { ConsoleMirrorPort, LoggerPort, type ClockPort, type HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { exchangeLine, fingerprintOf } from "@accounts-proxy/proxy/adapters/outbound/exchange-log-file.ts";
import { logLine } from "@accounts-proxy/proxy/adapters/outbound/system.ts";

export class TerminalMirror extends ConsoleMirrorPort {
  private started = false;

  constructor(private readonly write: (text: string) => void) {
    super();
  }

  start(): void {
    this.started = true;
  }

  line(text: string): void {
    if (!this.started) return;
    try {
      this.write(`${text}\n`);
    } catch {
      // the console copy is best-effort, like the files (X6)
    }
  }
}

/** A logger that also prints each line. */
export class MirroredLogger extends LoggerPort {
  constructor(
    private readonly inner: LoggerPort,
    private readonly mirror: ConsoleMirrorPort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  info(message: string): void {
    this.inner.info(message);
    this.mirror.line(logLine(this.clock.now(), "INFO", message));
  }
  warn(message: string): void {
    this.inner.warn(message);
    this.mirror.line(logLine(this.clock.now(), "WARN", message));
  }
  error(message: string, cause: unknown): void {
    this.inner.error(message, cause);
    this.mirror.line(logLine(this.clock.now(), "ERROR", `${message} :: ${(cause as Error).stack}`));
  }
}

/** An exchange sink that also prints each record, redacted as the file writes it. */
export class MirroredExchangeSink extends ExchangeSinkPort {
  private readonly redactor: Redactor;

  constructor(
    private readonly inner: ExchangeSinkPort,
    private readonly mirror: ConsoleMirrorPort,
    private readonly clock: ClockPort,
    hash: HashPort,
    private readonly pid: number,
  ) {
    super();
    this.redactor = new Redactor(fingerprintOf(hash));
  }

  write(entry: ExchangeEntry): void {
    this.inner.write(entry);
    this.mirror.line(exchangeLine(redactEntry(entry, this.redactor), this.clock.now(), this.pid));
  }
}
