// The log files (plan 2026-10-27-23-29 L1–L3, L6, W1). Each process writes only its own files,
// `<UTC day>-<pid>-<kind>.<ext>` (then `.1`, `.2`, … past the size cap), through winston and
// winston-daily-rotate-file: a new file at the UTC day change and past `maxFileMegabytes`, files 0600. Nothing is
// created before the first line. Deletion is the proxy's own sweep under the `logs` lock: every log file of the L2 form
// older than the retention, whichever process wrote it, and the former files moved in (L3b). winston's own deletion (`maxFiles`) is not used, so it keeps
// no audit file (file-stream-rotator 0.6.1 writes one only with `max_logs`; measured 2026-10-27).
import { mkdirSync } from "node:fs";
import type * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { LogRetentionPort, LogStreamPort, type ClockPort, type LockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";

/** The one lock the log sweep takes (W1). */
export const LOGS_LOCK = "logs";
const DAY_MS = 86_400_000;
const BYTES_PER_MEGABYTE = 1_048_576;
/** `<day>-<pid>-<kind>[.<n>].<ext>` (L2). */
export const LOG_FILE = /^(\d{4}-\d{2}-\d{2})-(\d+)-(usage|proxy)(?:\.\d+)?\.(?:jsonl|log)$/;
/** The former files moved in from `<home>/logs` (L3b): `exchanges-<day>.jsonl` (X1) and `proxy-<day of its last line>.log`. */
export const FORMER_LOG_FILE = /^(?:exchanges-(\d{4}-\d{2}-\d{2})\.jsonl|proxy-(\d{4}-\d{2}-\d{2})\.log)$/;
const dayIn = (name: string): string | undefined => LOG_FILE.exec(name)?.[1] ?? FORMER_LOG_FILE.exec(name)?.slice(1).find((day) => day !== undefined);

export type LogKind = { readonly name: "usage" | "proxy"; readonly extension: ".jsonl" | ".log" };
export const USAGE_LOG: LogKind = { name: "usage", extension: ".jsonl" };
export const PROXY_LOG: LogKind = { name: "proxy", extension: ".log" };

/** A log failure is never the caller's (best-effort by contract). */
const ignore = (): void => undefined;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The winston logger and its file transport, created at the first line. A rotation ends the previous file stream
 * (`end_stream: true`), which flushes on its own; every file stream's `close` reaches the transport's `logStream`
 * (file-stream-rotator 0.6.1 `BubbleEvents`), so `opened`/`closed` count them (measured 2026-10-27: waiting only for
 * the current stream lost the unflushed lines of the files rotated just before).
 */
type Open = { readonly logger: winston.Logger; readonly settle: () => void; opened: number; closed: number; allClosed?: () => void };

export class WinstonLogStream extends LogStreamPort {
  private open: Open | undefined;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly kind: LogKind,
    private readonly pid: number,
    private readonly maxFileMegabytes: number,
    /** Called at the first line and whenever a new file starts (the retention sweep, L3). */
    private readonly onNewFile: () => void,
  ) {
    super();
  }

  line(text: string): void {
    if (this.closed) return;
    try {
      (this.open ??= this.create()).logger.info(text);
    } catch {
      // logging is best-effort by contract
    }
  }

  /** Waits until every line is in its file: the logger ends, then every file stream it opened has closed. */
  async close(): Promise<void> {
    this.closed = true;
    const open = this.open;
    if (open === undefined) return;
    this.open = undefined;
    await new Promise<void>((resolve) => {
      open.allClosed = resolve;
      open.logger.end();
      open.settle();
    });
  }

  private create(): Open {
    mkdirSync(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const transport = new DailyRotateFile({
      dirname: this.directory,
      filename: `%DATE%-${this.pid}-${this.kind.name}`,
      extension: this.kind.extension,
      datePattern: "YYYY-MM-DD",
      utc: true,
      maxSize: this.maxFileMegabytes * BYTES_PER_MEGABYTE,
      options: { flags: "a", mode: PRIVATE_FILE_MODE },
    });
    const logger = winston.createLogger({ format: winston.format.printf((info) => String(info.message)), transports: [transport] });
    const open: Open = {
      logger,
      opened: 1,
      closed: 0,
      settle: () => {
        if (open.closed === open.opened) open.allClosed?.();
      },
    };
    transport.on("new", this.onNewFile);
    transport.on("rotate", () => (open.opened += 1));
    transport.logStream.on("close", () => {
      open.closed += 1;
      open.settle();
    });
    transport.logStream.on("error", ignore);
    transport.on("error", ignore);
    logger.on("error", ignore);
    return open;
  }
}

export type RetentionFs = Pick<typeof nodeFs, "mkdir" | "readdir" | "unlink" | "stat">;

export class LockedLogRetention extends LogRetentionPort {
  private running: Promise<void> | undefined;

  constructor(
    private readonly directory: string,
    private readonly lock: LockPort,
    private readonly clock: ClockPort,
    /** Days of files kept, today included (proxy.yaml `logs.retentionDays`). */
    private readonly retentionDays: number,
    /** Cap on total megabytes of log files kept (proxy.yaml `logs.maxTotalMegabytes`). */
    private readonly maxTotalMegabytes: number,
    private readonly fs: RetentionFs,
  ) {
    super();
  }

  /** One sweep at a time per process; a second request while one runs joins it. */
  sweep(): Promise<void> {
    this.running ??= this.lock
      .withLock(LOGS_LOCK, () => this.removeOld())
      .catch(ignore)
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async removeOld(): Promise<void> {
    await this.fs.mkdir(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const oldestKept = dayOf(this.clock.now() - (this.retentionDays - 1) * DAY_MS);
    const entries: { name: string; day: string; size: number; mtimeMs: number }[] = [];
    for (const name of await this.fs.readdir(this.directory)) {
      const day = dayIn(name);
      if (day !== undefined) {
        if (day < oldestKept) {
          await this.fs.unlink(join(this.directory, name)).catch(ignore);
        } else {
          try {
            const stats = await this.fs.stat(join(this.directory, name));
            entries.push({ name, day, size: stats.size, mtimeMs: stats.mtimeMs });
          } catch {
            // file vanished or unreadable
          }
        }
      }
    }
    const maxBytes = this.maxTotalMegabytes * BYTES_PER_MEGABYTE;
    let totalBytes = entries.reduce((acc, e) => acc + e.size, 0);
    if (totalBytes > maxBytes) {
      entries.sort((a, b) => a.day.localeCompare(b.day) || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (totalBytes <= maxBytes) break;
        try {
          await this.fs.unlink(join(this.directory, entry.name));
          totalBytes -= entry.size;
        } catch {
          // ignore unlink error
        }
      }
    }
  }
}
