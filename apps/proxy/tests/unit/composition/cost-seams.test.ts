import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as nodeFs from "node:fs/promises";
import { BrowserLauncherPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { ScriptedTransport } from "@accounts-proxy/test-support/fakes.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";
import { costSeamsOf, PRODUCTION_LOCK, runCli, type ContainerOptions } from "@accounts-proxy/proxy/composition/container.ts";

/** Writes an executable `name` into `dir` and answers `dir`, so it can be prepended to `PATH`. */
function stub(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

/** Runs `body` with `dirs` first on `PATH`, and always puts the previous value back. */
async function withPath<T>(dirs: readonly string[], body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = [...dirs, saved ?? ""].join(":");
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/** Runs `body` with exactly `dirs` on `PATH`, so nothing outside them can be found. */
async function withOnlyPath<T>(dirs: readonly string[], body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = [...dirs].join(":");
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

/**
 * Bun 1.4.2 resolves a spawn's command against the environment the process started with unless `env` is passed, and
 * the seams pass none (measured: with `PATH` rewritten in-process, `Bun.spawn(["opencode"])` still ran the binary from
 * the startup `PATH`; passing `env: process.env` ran the stub). Hand the live environment through while `body` runs,
 * so the seam still spawns a real process and every branch below is reached.
 */
async function withSpawnEnv<T>(body: () => Promise<T>): Promise<T> {
  const captured = Bun.spawn;
  Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0], options: Parameters<typeof Bun.spawn>[1] = {}) =>
    captured(command, { ...options, env: { ...process.env, ...options?.env } })) as typeof Bun.spawn;
  try {
    return await body();
  } finally {
    Bun.spawn = captured;
  }
}

/** A fresh temporary directory, created through the guarded helper the project law requires. */
function tempDir(): string {
  return makeTemporary("cost-seams");
}

/** `notify` fires the spawn without awaiting it, so wait for the child to finish writing `path`. */
async function settle(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`cost-seams: ${path} was never written`);
}

describe("costSeamsOf", () => {
  test("now answers the clock it was handed", () => {
    expect(costSeamsOf(() => 1_700_000_000_000).now()).toBe(1_700_000_000_000);
  });

  test("sleep settles after the delay", async () => {
    const seams = costSeamsOf(() => 0);
    await expect(seams.sleep(1)).resolves.toBeUndefined();
  });

  test("reconcile reports the estimate opencode printed, with the window it covered", async () => {
    const bin = tempDir();
    try {
      stub(bin, "opencode", `#!/bin/sh\nprintf '%s' '{"cost":1.234}'\nexit 0\n`);
      const seams = costSeamsOf(() => 0);
      const outcome = await withPath([bin], () => withSpawnEnv(() => seams.reconcile(7)));
      expect(outcome).toEqual({ estimate: 1.234, days: 7 });
    } finally {
      removeTemporary(bin);
    }
  });

  test("reconcile treats a non-zero exit as unreadable", async () => {
    const bin = tempDir();
    try {
      stub(bin, "opencode", `#!/bin/sh\nexit 2\n`);
      const seams = costSeamsOf(() => 0);
      await expect(withPath([bin], () => withSpawnEnv(() => seams.reconcile(7)))).resolves.toEqual({ skipped: "unreadable" });
    } finally {
      removeTemporary(bin);
    }
  });

  test("reconcile treats malformed JSON as unreadable", async () => {
    const bin = tempDir();
    try {
      stub(bin, "opencode", `#!/bin/sh\nprintf '%s' 'not json'\nexit 0\n`);
      const seams = costSeamsOf(() => 0);
      await expect(withPath([bin], () => withSpawnEnv(() => seams.reconcile(7)))).resolves.toEqual({ skipped: "unreadable" });
    } finally {
      removeTemporary(bin);
    }
  });

  test("reconcile treats a payload without a numeric cost as unreadable", async () => {
    const bin = tempDir();
    try {
      stub(bin, "opencode", `#!/bin/sh\nprintf '%s' '{"sessions":3}'\nexit 0\n`);
      const seams = costSeamsOf(() => 0);
      await expect(withPath([bin], () => withSpawnEnv(() => seams.reconcile(7)))).resolves.toEqual({ skipped: "unreadable" });
    } finally {
      removeTemporary(bin);
    }
  });

  test("reconcile reports a missing opencode as not-found", async () => {
    const empty = tempDir();
    try {
      const seams = costSeamsOf(() => 0);
      await expect(withOnlyPath([empty], () => withSpawnEnv(() => seams.reconcile(7)))).resolves.toEqual({ skipped: "not-found" });
    } finally {
      removeTemporary(empty);
    }
  });

  test("notify hands the title and the body to notify-send", async () => {
    const bin = tempDir();
    const out = join(bin, "argv");
    try {
      stub(bin, "notify-send", `#!/bin/sh\nprintf '%s' "$*" > "${out}"\nexit 0\n`);
      const seams = costSeamsOf(() => 0);
      const result = await withPath([bin], () =>
        withSpawnEnv(async () => {
          await seams.notify("title", "body");
          return undefined;
        }),
      );
      expect(result).toBeUndefined();
      expect(await settle(out)).toBe("title body");
    } finally {
      removeTemporary(bin);
    }
  });

  test("notify swallows a host without a notification daemon", async () => {
    const empty = tempDir();
    try {
      const seams = costSeamsOf(() => 0);
      await expect(withOnlyPath([empty], () => withSpawnEnv(async () => seams.notify("t", "b")))).resolves.toBeUndefined();
    } finally {
      removeTemporary(empty);
    }
  });
});

class SilentBrowser extends BrowserLauncherPort {
  async open(_url: string): Promise<void> {}
}

class NeverShutDown extends ShutdownSignal {
  wait(): Promise<string> {
    return new Promise(() => {});
  }
}

describe("the composition root's spend report", () => {
  test("cost reads the clock buildCli gave the spend report", async () => {
    const home = tempDir();
    try {
      const out: string[] = [];
      const err: string[] = [];
      const opts: ContainerOptions = {
        home,
        accounts: { path: join(home, "accounts.json"), fs: nodeFs },
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        transport: new ScriptedTransport(() => ({ status: 404, body: "" })),
        browser: new SilentBrowser(),
        shutdown: new NeverShutDown(),
        lock: PRODUCTION_LOCK,
        seams: {},
        listenHost: "127.0.0.1",
        entry: ["/usr/bin/bun", "/app/cli.ts"],
      };
      // No `--day`: the window is resolved from the clock the composition root handed the service.
      expect(await runCli(["cost", "--json"], opts), `stderr: ${err.join("")}`).toBe(0);
      const printed = out.join("");
      expect(printed).toContain('"window"');
      expect(printed).toContain('"coverage"');
    } finally {
      removeTemporary(home);
    }
  });
});
