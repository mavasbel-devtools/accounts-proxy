// Runtime-backed system ports.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ClockPort, HashPort, LoggerPort, RandomPort, TimerPort, type LogStreamPort } from "@accounts-proxy/core/ports/outbound/system.ts";

export class SystemClock extends ClockPort {
  now(): number {
    return Date.now();
  }
}

export class CryptoRandom extends RandomPort {
  uuid(): string {
    return randomUUID();
  }
  bytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  }
}

export class NodeHash extends HashPort {
  sha256(input: string): Uint8Array {
    return new Uint8Array(createHash("sha256").update(input, "utf8").digest());
  }
}

export class SystemTimer extends TimerPort {
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** One log line: ISO timestamp, level, message (proxy.log and the daemon's console, plan 2026-10-27 C1). */
export function logLine(now: number, level: string, message: string): string {
  return `${new Date(now).toISOString()} ${level} ${message}`;
}

/**
 * The daemon log: ISO timestamp, level, message, one line each into the process's proxy log stream (plan
 * 2026-10-27-23-29 L2). Never writes to the console (the CLI owns the terminal) and never throws into the caller — a
 * logging failure must not break a request or a login. Callers never pass secrets.
 */
export class StreamLogger extends LoggerPort {
  constructor(
    private readonly stream: LogStreamPort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  info(message: string): void {
    this.write("INFO", message);
  }
  warn(message: string): void {
    this.write("WARN", message);
  }
  /** The cause's stack follows the message (every caught value is an Error, see errorMessage). */
  error(message: string, cause: unknown): void {
    this.write("ERROR", `${message} :: ${(cause as Error).stack}`);
  }

  private write(level: string, message: string): void {
    this.stream.line(logLine(this.clock.now(), level, message));
  }
}
