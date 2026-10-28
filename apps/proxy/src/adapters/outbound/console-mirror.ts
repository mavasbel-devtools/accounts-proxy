// The daemon's console output (plan 2026-10-27 C1, amended by plan 2026-10-27-23-29 L5): `serve` prints every log line
// (as the proxy log has it), each on its own line of stdout; the usage records go only to the usage files. Commands
// other than `serve` never start the mirror, so their output stays what scripts read.
import { ConsoleMirrorPort, LoggerPort, type ClockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
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
