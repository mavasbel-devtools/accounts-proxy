// Outbound system ports: time, randomness, hashing, logging, log files, locking, browser.

export abstract class ClockPort {
  /** Milliseconds since the Unix epoch. */
  abstract now(): number;
}

export abstract class TimerPort {
  abstract sleep(ms: number): Promise<void>;
}

export abstract class RandomPort {
  abstract uuid(): string;
  abstract bytes(length: number): Uint8Array;
}

export abstract class HashPort {
  abstract sha256(input: string): Uint8Array;
}

export abstract class LoggerPort {
  abstract info(message: string): void;
  abstract warn(message: string): void;
  abstract error(message: string, cause: unknown): void;
}

/**
 * An append-only family of log files that takes complete lines (plan 2026-10-27-23-29 L2). `line` never throws;
 * `close` writes out what is buffered and releases the files (L6).
 */
export abstract class LogStreamPort {
  abstract line(text: string): void;
  abstract close(): Promise<void>;
}

/** Removes the log files past the retention (plan 2026-10-27-23-29 L3). Never rejects. */
export abstract class LogRetentionPort {
  abstract sweep(): Promise<void>;
}

/** Mutual exclusion that holds across processes (the proxy daemon and a concurrent CLI command). */
export abstract class LockPort {
  abstract withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export abstract class BrowserLauncherPort {
  abstract open(url: string): Promise<void>;
}

/** The terminal copy of the daemon's log lines and exchange records: silent until started (plan 2026-10-27 C1). */
export abstract class ConsoleMirrorPort {
  abstract start(): void;
  /** One complete line, without its newline; dropped while not started. Never throws. */
  abstract line(text: string): void;
}
