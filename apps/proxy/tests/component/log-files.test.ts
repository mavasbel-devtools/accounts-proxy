// The log files on the real filesystem with the pinned winston 3.19.0 / winston-daily-rotate-file 5.0.0
// (plan 2026-10-27-23-29 L1–L3, L6, W1).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { LockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { DEFAULT_LOCK_OPTIONS, FileLock } from "@accounts-proxy/proxy/adapters/outbound/file-lock.ts";
import { dayOf, LOG_FILE, LockedLogRetention, PROXY_LOG, USAGE_LOG, WinstonLogStream, type RetentionFs } from "@accounts-proxy/proxy/adapters/outbound/log-files.ts";
import { SystemClock, SystemTimer } from "@accounts-proxy/proxy/adapters/outbound/system.ts";
import { FixedClock, RecordingLock } from "@accounts-proxy/test-support/fakes.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeTemporary(dir);
  dir = undefined;
});
const temp = () => (dir = makeTemporary("log-files"));
const T = Date.parse("2026-10-26T12:00:00.000Z");
const today = () => dayOf(Date.now());
const linesIn = (folder: string, pattern: RegExp) =>
  readdirSync(folder)
    .filter((name) => pattern.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(folder, name), "utf8").split("\n").filter((line) => line !== ""));

describe("WinstonLogStream", () => {
  test("nothing is created before the first line; then <UTC day>-<pid>-<kind> files, every line on disk after close", async () => {
    const logs = join(temp(), "logs");
    let newFiles = 0;
    const stream = new WinstonLogStream(logs, USAGE_LOG, 4242, 100, () => void (newFiles += 1));
    expect(existsSync(logs)).toBe(false);
    for (let i = 0; i < 2000; i++) stream.line(JSON.stringify({ n: i }));
    await stream.close();
    expect(newFiles).toBeGreaterThanOrEqual(1);
    expect(readdirSync(logs).filter((name) => LOG_FILE.test(name))).toEqual([`${today()}-4242-usage.jsonl`]);
    expect(readdirSync(logs).filter((name) => !LOG_FILE.test(name))).toEqual([]);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(join(logs, `${today()}-4242-usage.jsonl`)).mode & 0o777).toBe(0o600);
    expect(linesIn(logs, LOG_FILE)).toEqual(Array.from({ length: 2000 }, (_, n) => JSON.stringify({ n })));
  });

  test("past maxFileMegabytes a new file starts (.1, .2, …), each start announced; lines after close are dropped", async () => {
    const logs = join(temp(), "logs");
    let newFiles = 0;
    const stream = new WinstonLogStream(logs, PROXY_LOG, 7, 1, () => void (newFiles += 1));
    const line = "x".repeat(1023);
    for (let i = 0; i < 2500; i++) stream.line(line);
    await stream.close();
    stream.line("after close");
    const names = readdirSync(logs).filter((name) => LOG_FILE.test(name)).sort();
    expect(names).toEqual([`${today()}-7-proxy.1.log`, `${today()}-7-proxy.2.log`, `${today()}-7-proxy.log`]);
    expect(newFiles).toBeGreaterThanOrEqual(3);
    expect(linesIn(logs, LOG_FILE)).toHaveLength(2500);
    for (const name of names) expect(statSync(join(logs, name)).size).toBeLessThanOrEqual(1_048_576 + 1024);
  });

  test("close without a line does nothing; a folder that cannot be created never throws", async () => {
    const root = temp();
    await new WinstonLogStream(join(root, "unused"), USAGE_LOG, 1, 100, () => undefined).close();
    expect(existsSync(join(root, "unused"))).toBe(false);
    writeFileSync(join(root, "file"), "not a directory");
    const blocked = new WinstonLogStream(join(root, "file", "logs"), USAGE_LOG, 1, 100, () => undefined);
    expect(() => blocked.line("x")).not.toThrow();
    await blocked.close();
  });

  test("a file that cannot be opened is swallowed and close still returns", async () => {
    const logs = join(temp(), "logs");
    mkdirSync(join(logs, `${today()}-9-usage.jsonl`), { recursive: true });
    const stream = new WinstonLogStream(logs, USAGE_LOG, 9, 100, () => undefined);
    expect(() => stream.line("x")).not.toThrow();
    await Bun.sleep(50);
    await stream.close();
  });

  test("two processes' streams in one folder keep their own files and every line whole", async () => {
    const logs = join(temp(), "logs");
    const a = new WinstonLogStream(logs, USAGE_LOG, 1, 1, () => undefined);
    const b = new WinstonLogStream(logs, USAGE_LOG, 2, 1, () => undefined);
    const pad = "y".repeat(500);
    for (let i = 0; i < 3000; i++) {
      a.line(JSON.stringify({ w: "a", i, pad }));
      b.line(JSON.stringify({ w: "b", i, pad }));
    }
    await Promise.all([a.close(), b.close()]);
    for (const [pid, w] of [[1, "a"], [2, "b"]] as const) {
      const lines = linesIn(logs, new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${pid}-usage(\\.\\d+)?\\.jsonl$`)).map((line) => JSON.parse(line));
      expect(lines).toHaveLength(3000);
      expect(lines.every((entry) => entry.w === w)).toBe(true);
    }
  });
});

describe("LockedLogRetention", () => {
  test("under the logs lock: log files and former moved-in files older than retentionDays (today included) go, whichever process wrote them; the rest stays", async () => {
    const logs = join(temp(), "logs");
    mkdirSync(logs, { recursive: true });
    const names = [
      "2026-10-24-5-usage.jsonl",
      "2026-10-24-5-proxy.3.log",
      "2026-10-25-5-usage.jsonl",
      "2026-10-26-5-usage.1.jsonl",
      "2026-10-01-0-proxy.log",
      "notes.txt",
      "exchanges-2026-10-01.jsonl",
      "exchanges-2026-10-25.jsonl",
      "proxy-2026-10-01.log",
      "proxy-2026-10-26.log",
      "exchanges-notes.jsonl",
      "proxy.log",
    ];
    for (const name of names) writeFileSync(join(logs, name), "x\n");
    const lock = new RecordingLock();
    await new LockedLogRetention(logs, lock, new FixedClock(T), 2, nodeFs).sweep();
    expect(lock.acquired).toEqual(["logs"]);
    expect(readdirSync(logs).sort()).toEqual(["2026-10-25-5-usage.jsonl", "2026-10-26-5-usage.1.jsonl", "exchanges-2026-10-25.jsonl", "exchanges-notes.jsonl", "notes.txt", "proxy-2026-10-26.log", "proxy.log"]);
  });

  test("a sweep requested while one runs joins it; the next request runs again", async () => {
    const logs = join(temp(), "logs");
    const lock = new RecordingLock();
    let release: () => void = () => undefined;
    lock.onAcquire = () => new Promise<void>((resolve) => (release = resolve));
    const clock = new FixedClock(T);
    const retention = new LockedLogRetention(logs, lock, clock, 15, nodeFs);
    const first = retention.sweep();
    const joined = retention.sweep();
    expect(joined).toBe(first);
    await Bun.sleep(5);
    release();
    await first;
    lock.onAcquire = undefined;
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "2026-10-01-1-usage.jsonl"), "x\n");
    await retention.sweep();
    expect(lock.acquired).toEqual(["logs", "logs"]);
    expect(readdirSync(logs)).toEqual([]);
  });

  test("never rejects: a lock that fails, a folder that cannot be read and a file that cannot be removed are swallowed", async () => {
    const root = temp();
    const failingLock = new (class extends LockPort {
      withLock<T>(): Promise<T> {
        return Promise.reject(new Error("lock timeout"));
      }
    })();
    await new LockedLogRetention(join(root, "logs"), failingLock, new FixedClock(T), 1, nodeFs).sweep();
    writeFileSync(join(root, "file"), "x");
    await new LockedLogRetention(join(root, "file"), new RecordingLock(), new FixedClock(T), 1, nodeFs).sweep();
    const logs = join(root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "2026-10-01-1-usage.jsonl"), "x\n");
    const noUnlink: RetentionFs = { ...nodeFs, unlink: (() => Promise.reject(new Error("EPERM"))) as RetentionFs["unlink"] };
    await new LockedLogRetention(logs, new RecordingLock(), new FixedClock(T), 1, noUnlink).sweep();
    expect(readdirSync(logs)).toEqual(["2026-10-01-1-usage.jsonl"]);
  });

  test("with the real file lock two sweeps of different processes' objects run one after the other", async () => {
    const root = temp();
    const logs = join(root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "2026-10-01-1-usage.jsonl"), "x\n");
    const lockOf = () => new FileLock(root, new SystemClock(), new SystemTimer(), { ...DEFAULT_LOCK_OPTIONS, pollMs: 2 }, nodeFs);
    const sweeps = [lockOf(), lockOf()].map((lock) => new LockedLogRetention(logs, lock, new FixedClock(T), 1, nodeFs).sweep());
    await Promise.all(sweeps);
    expect(readdirSync(logs)).toEqual([]);
    expect(readdirSync(join(root, "locks"))).toEqual([]);
  });
});
