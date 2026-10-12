// Runtime-backed system ports.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ClockPort, HashPort, LoggerPort, RandomPort, TimerPort } from "@inference-router/core/ports/outbound/system.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@inference-router/router/adapters/outbound/file-stores.ts";

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

/**
 * Append-only file log: ISO timestamp, level, message. Never writes to the console (the CLI owns the terminal) and
 * never throws into the caller — a logging failure must not break a request or a login. Callers never pass secrets.
 */
export class FileLogger extends LoggerPort {
  constructor(
    private readonly path: string,
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
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      appendFileSync(this.path, `${new Date(this.clock.now()).toISOString()} ${level} ${message}\n`, { mode: PRIVATE_FILE_MODE });
    } catch {
      // logging is best-effort by contract
    }
  }
}
