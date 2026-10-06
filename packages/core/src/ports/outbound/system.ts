// Outbound system ports: time, randomness, hashing, logging, locking, browser.

export abstract class ClockPort {
  /** Milliseconds since the Unix epoch. */
  abstract now(): number;
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
  abstract error(message: string, cause?: unknown): void;
}

/** Mutual exclusion that holds across processes (the router daemon and a concurrent CLI command). */
export abstract class LockPort {
  abstract withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export abstract class BrowserLauncherPort {
  abstract open(url: string): Promise<void>;
}
