// Cross-process mutual exclusion: an exclusively created lock file (`wx` = O_CREAT|O_EXCL, atomic on NTFS and POSIX).
// Holders in the same process are additionally queued in memory, so one process never contends with itself.
// A lock file older than `staleMs` (a crashed holder) is removed and acquisition is retried; waiting longer than
// `timeoutMs` fails with a named error instead of hanging.
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { LockPort } from "@inference-router/core/ports/outbound/system.ts";
import type { ClockPort, TimerPort } from "@inference-router/core/ports/outbound/system.ts";

export class LockTimeoutError extends Error {
  constructor(readonly path: string, timeoutMs: number) {
    super(`could not acquire ${path} within ${timeoutMs} ms`);
    this.name = "LockTimeoutError";
  }
}

export type FileLockOptions = { readonly staleMs: number; readonly timeoutMs: number; readonly pollMs: number };
export const DEFAULT_LOCK_OPTIONS: FileLockOptions = { staleMs: 60_000, timeoutMs: 90_000, pollMs: 50 };

const NAME = /^[a-z0-9-]+$/;

/** The filesystem calls the lock needs (a seam: races such as a lock file vanishing mid-inspection are otherwise untestable). */
export type LockFs = Pick<typeof nodeFs, "mkdir" | "open" | "stat" | "unlink">;

export class FileLock extends LockPort {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    private readonly clock: ClockPort,
    private readonly timer: TimerPort,
    private readonly options: FileLockOptions = DEFAULT_LOCK_OPTIONS,
    private readonly fs: LockFs = nodeFs,
  ) {
    super();
  }

  withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (!NAME.test(name)) return Promise.reject(new Error(`invalid lock name ${JSON.stringify(name)}`));
    const previous = this.queues.get(name) ?? Promise.resolve();
    const run = previous.then(() => this.holdFile(name, work));
    this.queues.set(name, run.catch(() => undefined));
    return run;
  }

  private async holdFile<T>(name: string, work: () => Promise<T>): Promise<T> {
    const path = join(this.directory, "locks", `${name}.lock`);
    await this.fs.mkdir(join(this.directory, "locks"), { recursive: true });
    const deadline = this.clock.now() + this.options.timeoutMs;
    for (;;) {
      try {
        const handle = await this.fs.open(path, "wx");
        await handle.writeFile(`${process.pid} ${this.clock.now()}\n`);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.isStale(path)) {
          await this.fs.unlink(path).catch(() => undefined);
          continue;
        }
        if (this.clock.now() >= deadline) throw new LockTimeoutError(path, this.options.timeoutMs);
        await this.timer.sleep(this.options.pollMs);
      }
    }
    try {
      return await work();
    } finally {
      await this.fs.unlink(path).catch(() => undefined);
    }
  }

  /** A lock file that vanished between the failed create and this check is not stale: the next attempt takes it. */
  private async isStale(path: string): Promise<boolean> {
    try {
      return this.clock.now() - (await this.fs.stat(path)).mtimeMs > this.options.staleMs;
    } catch {
      return false;
    }
  }
}
