// Cross-process mutual exclusion: an exclusively created lock file (`wx` = O_CREAT|O_EXCL, atomic on NTFS and POSIX).
// Holders in the same process are additionally queued in memory, so one process never contends with itself.
// A lock file older than `staleMs` (a crashed holder) is removed and acquisition is retried; waiting longer than
// `timeoutMs` fails with a named error instead of hanging.
import type * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { LockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { ClockPort, TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";

export class LockTimeoutError extends Error {
  constructor(readonly path: string, timeoutMs: number) {
    super(`could not acquire ${path} within ${timeoutMs} ms`);
    this.name = "LockTimeoutError";
  }
}

export type FileLockOptions = { readonly staleMs: number; readonly timeoutMs: number; readonly pollMs: number };
export const DEFAULT_LOCK_OPTIONS: FileLockOptions = { staleMs: 60_000, timeoutMs: 90_000, pollMs: 50 };

/** The filesystem calls the lock needs (a seam: races such as a lock file vanishing mid-inspection are otherwise untestable). */
export type LockFs = Pick<typeof nodeFs, "mkdir" | "open" | "stat" | "unlink">;

export class FileLock extends LockPort {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    private readonly clock: ClockPort,
    private readonly timer: TimerPort,
    private readonly options: FileLockOptions,
    private readonly fs: LockFs,
  ) {
    super();
  }

  /** Names are the providers' constant lock names (no user input reaches them). */
  withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const run = previous.then(() => this.holdFile(name, work));
    this.queues.set(name, run.catch(() => undefined));
    return run;
  }

  private async holdFile<T>(name: string, work: () => Promise<T>): Promise<T> {
    const path = join(this.directory, "locks", `${name}.lock`);
    await this.fs.mkdir(join(this.directory, "locks"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const deadline = this.clock.now() + this.options.timeoutMs;
    for (;;) {
      try {
        const handle = await this.fs.open(path, "wx", PRIVATE_FILE_MODE);
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

/**
 * Hermetic-test hook (ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES): every stat of a busy lock reports the file gone, as
 * when its holder releases it between the failed create and the stale check.
 */
export function vanishingStatFs(fs: LockFs): LockFs {
  const gone = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
  return { ...fs, stat: ((path: string) => Promise.reject(gone(path))) as LockFs["stat"] };
}
