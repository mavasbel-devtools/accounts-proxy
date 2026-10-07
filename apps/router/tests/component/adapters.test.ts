import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EMPTY_POOL, upsertAccount } from "../../../../packages/core/src/domain/accounts.ts";
import { ConfigError } from "../../../../packages/core/src/domain/config.ts";
import { base64UrlEncode } from "../../../../packages/core/src/domain/services/base64url.ts";
import { readAll } from "../../../../packages/core/src/domain/wire.ts";
import { FixedClock } from "../../../../tests/support/fakes.ts";
import { makeTemporary, removeTemporary } from "../../../../tests/support/temporary.ts";
import { browserCommand, SystemBrowserLauncher, type Spawner } from "../../src/adapters/outbound/browser-launcher.ts";
import { FetchTransport } from "../../src/adapters/outbound/fetch-transport.ts";
import { DEFAULT_LOCK_OPTIONS, FileLock, LockTimeoutError } from "../../src/adapters/outbound/file-lock.ts";
import { FileCredentialStore, FileKeyValueStore, StoreCorruptError, writeJsonAtomic } from "../../src/adapters/outbound/file-stores.ts";
import { CallbackTimeoutError, LoopbackCallbackServer, LoopbackCallbackServerFactory } from "../../src/adapters/outbound/loopback-callback-server.ts";
import { CryptoRandom, FileLogger, NodeHash, SystemClock, SystemTimer } from "../../src/adapters/outbound/system.ts";
import { TerminalManualCode } from "../../src/adapters/outbound/terminal-manual-code.ts";
import { YamlConfigFile } from "../../src/adapters/outbound/yaml-config-file.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeTemporary(dir);
  dir = undefined;
});
const temp = () => (dir = makeTemporary("router-adapters"));

describe("file stores", () => {
  test("credential pool: missing → empty; atomic round trip; 0600 where supported; BOM tolerated", async () => {
    const store = new FileCredentialStore(temp());
    expect(await store.load("antigravity")).toBe(EMPTY_POOL);
    const pool = upsertAccount(EMPTY_POOL, { provider: "antigravity", id: "me@x", label: "me@x", data: { tokens: { accessToken: "a" } } });
    await store.save("antigravity", pool);
    expect(await store.load("antigravity")).toEqual(pool);
    const path = store.path("antigravity");
    expect(path).toBe(join(dir!, "accounts-antigravity.json"));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, `\uFEFF${readFileSync(path, "utf8")}`);
    expect(await store.load("antigravity")).toEqual(pool);
    await store.save("antigravity", { accounts: pool.accounts });
    expect(await store.load("antigravity")).toEqual({ accounts: pool.accounts });
  });

  test.each([["{oops"], ["[]"], ['{"accounts":{}}'], ['{"accounts":[{"provider":"claude-subscription","id":"x","label":"x","data":{}}]}'], ['{"accounts":[{"provider":"antigravity","id":1,"label":"x","data":{}}]}']])(
    "a corrupt pool %p is an error, never an empty pool",
    async (content) => {
      const store = new FileCredentialStore(temp());
      writeFileSync(store.path("antigravity"), content);
      await expect(store.load("antigravity")).rejects.toBeInstanceOf(StoreCorruptError);
    },
  );

  test("an unreadable path is not mistaken for a missing file", async () => {
    const store = new FileCredentialStore(temp());
    mkdirSync(store.path("antigravity"));
    await expect(store.load("antigravity")).rejects.toHaveProperty("code");
  });

  test("key-value store: nested keys, missing → undefined, invalid keys refused", async () => {
    const kv = new FileKeyValueStore(temp());
    expect(await kv.read("claude-subscription/device-id")).toBeUndefined();
    await kv.write("claude-subscription/device-id", "ab");
    expect(await kv.read("claude-subscription/device-id")).toBe("ab");
    expect(kv.path("a/b")).toBe(join(dir!, "state", "a", "b.json"));
    for (const bad of ["../x", "A", "a//b", "", "a/"]) expect(() => kv.path(bad)).toThrow("invalid state key");
  });

  test("atomic write removes its temp file when the rename fails", async () => {
    const root = temp();
    mkdirSync(join(root, "target"));
    await expect(writeJsonAtomic(join(root, "target"), {}, 0o600)).rejects.toBeDefined();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root)).toEqual(["target"]);
    const fs = await import("node:fs/promises");
    const failing = { ...fs, writeFile: (() => Promise.reject(new Error("disk full"))) as unknown as typeof fs.writeFile, unlink: (() => Promise.reject(new Error("ENOENT"))) as unknown as typeof fs.unlink };
    await expect(writeJsonAtomic(join(root, "x.json"), {}, 0o600, failing)).rejects.toThrow("disk full");
  });
});

describe("FileLock", () => {
  test("serializes holders across instances (two processes' view) and in process", async () => {
    const root = temp();
    const clock = new SystemClock();
    const timer = new SystemTimer();
    const a = new FileLock(root, clock, timer, { ...DEFAULT_LOCK_OPTIONS, pollMs: 5 });
    const b = new FileLock(root, clock, timer, { ...DEFAULT_LOCK_OPTIONS, pollMs: 5 });
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(`${name}+`);
      await Bun.sleep(20);
      order.push(`${name}-`);
      return name;
    };
    expect(await Promise.all([a.withLock("x", job("a1")), b.withLock("x", job("b1")), a.withLock("x", job("a2"))])).toEqual(["a1", "b1", "a2"]);
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(0, -1)).toBe(order[i + 1]!.slice(0, -1));
  });

  test("a failing holder releases the lock; invalid names refused", async () => {
    const lock = new FileLock(temp(), new SystemClock(), new SystemTimer());
    await expect(lock.withLock("x", () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
    expect(await lock.withLock("x", async () => "next")).toBe("next");
    await expect(lock.withLock("../x", async () => 1)).rejects.toThrow("invalid lock name");
  });

  test("a stale lock file is broken; a live one times out", async () => {
    const root = temp();
    mkdirSync(join(root, "locks"));
    const file = join(root, "locks", "x.lock");
    writeFileSync(file, "999 0\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    const lock = new FileLock(root, new SystemClock(), new SystemTimer(), { staleMs: 60_000, timeoutMs: 200, pollMs: 5 });
    expect(await lock.withLock("x", async () => "broke stale")).toBe("broke stale");
    writeFileSync(file, "999 0\n");
    const started = Date.now();
    await expect(lock.withLock("x", async () => "never")).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("a lock file that vanishes while being inspected is not stale; a non-EEXIST create error propagates", async () => {
    const root = temp();
    const fs = await import("node:fs/promises");
    const errno = (code: string) => Object.assign(new Error(code), { code });
    let opens = 0;
    const vanishing = new FileLock(root, new SystemClock(), new SystemTimer(), { staleMs: 60_000, timeoutMs: 10_000, pollMs: 1 }, {
      ...fs,
      open: ((...args: Parameters<typeof fs.open>) => (opens++ === 0 ? Promise.reject(errno("EEXIST")) : fs.open(...args))) as typeof fs.open,
      stat: (() => Promise.reject(errno("ENOENT"))) as unknown as typeof fs.stat,
    });
    expect(await vanishing.withLock("x", async () => "ok")).toBe("ok");
    expect(opens).toBe(2);
    const denied = new FileLock(root, new SystemClock(), new SystemTimer(), DEFAULT_LOCK_OPTIONS, { ...fs, open: (() => Promise.reject(errno("EACCES"))) as unknown as typeof fs.open });
    await expect(denied.withLock("x", async () => 1)).rejects.toHaveProperty("code", "EACCES");
  });

  test("a failing unlink (stale removal or release) is tolerated", async () => {
    const root = temp();
    const fs = await import("node:fs/promises");
    mkdirSync(join(root, "locks"));
    const file = join(root, "locks", "x.lock");
    writeFileSync(file, "1 0\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    let unlinks = 0;
    const stuck = new FileLock(root, new SystemClock(), new SystemTimer(), { staleMs: 60_000, timeoutMs: 10_000, pollMs: 1 }, {
      ...fs,
      unlink: (async (path: Parameters<typeof fs.unlink>[0]) => {
        unlinks++;
        await fs.unlink(path);
        throw new Error("unlink reported failure after removing");
      }) as typeof fs.unlink,
    });
    expect(await stuck.withLock("x", async () => "ok")).toBe("ok");
    expect(unlinks).toBe(2);
  });
});

describe("FetchTransport", () => {
  test("streams the body as it arrives, lower-cases headers, sends method/headers/body; timeout aborts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/slow") {
          await Bun.sleep(500);
          return new Response("late");
        }
        if (url.pathname === "/empty") return new Response(null, { status: 204 });
        const echo = `${req.method} ${req.headers.get("x-test")} ${await req.text()}`;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(`first:${echo}`));
            await gate;
            controller.enqueue(new TextEncoder().encode("|second"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "X-Mixed-Case": "v", "content-type": "text/plain" } });
      },
    });
    try {
      const transport = new FetchTransport();
      const res = await transport.send({ method: "POST", url: `http://127.0.0.1:${server.port}/echo`, headers: { "x-test": "1" }, body: "hi" });
      expect(res.status).toBe(200);
      expect(res.headers["x-mixed-case"]).toBe("v");
      const it = res.body[Symbol.asyncIterator]();
      expect(new TextDecoder().decode((await it.next()).value)).toBe("first:POST 1 hi");
      release();
      expect(new TextDecoder().decode((await it.next()).value)).toBe("|second");
      const empty = await transport.send({ method: "GET", url: `http://127.0.0.1:${server.port}/empty`, headers: {} });
      expect(await readAll(empty.body)).toBe("");
      await expect(transport.send({ method: "GET", url: `http://127.0.0.1:${server.port}/slow`, headers: {}, timeoutMs: 50 })).rejects.toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});

describe("system adapters", () => {
  test("clock, random, timer", async () => {
    const before = Date.now();
    expect(new SystemClock().now()).toBeGreaterThanOrEqual(before);
    const random = new CryptoRandom();
    expect(random.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(random.bytes(32)).toHaveLength(32);
    const t0 = Date.now();
    await new SystemTimer().sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  test("SHA-256 + base64url gives the RFC 7636 appendix B S256 challenge", () => {
    expect(base64UrlEncode(new NodeHash().sha256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("file logger writes ISO-stamped lines and never throws", () => {
    const root = temp();
    const path = join(root, "logs", "router.log");
    const logger = new FileLogger(path, new FixedClock(0));
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.error("e2", "cause");
    logger.error("e3", new Error("boom"));
    const text = readFileSync(path, "utf8");
    expect(text.split("\n").slice(0, 4)).toEqual(["1970-01-01T00:00:00.000Z INFO i", "1970-01-01T00:00:00.000Z WARN w", "1970-01-01T00:00:00.000Z ERROR e", "1970-01-01T00:00:00.000Z ERROR e2 :: cause"]);
    expect(text).toContain("ERROR e3 :: Error: boom");
    const noStack = new Error("plain");
    delete noStack.stack;
    logger.error("e4", noStack);
    expect(readFileSync(path, "utf8")).toContain("ERROR e4 :: plain");
    mkdirSync(join(root, "dir.log"));
    expect(() => new FileLogger(join(root, "dir.log"), new FixedClock(0)).info("x")).not.toThrow();
  });
});

describe("SystemBrowserLauncher", () => {
  test("platform commands: one quoted URL token with verbatim arguments on Windows", () => {
    const url = "https://a.example/?x=1&y=2";
    expect(browserCommand("win32", url)).toEqual({ command: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true });
    expect(browserCommand("darwin", url)).toEqual({ command: "open", args: [url], verbatim: false });
    expect(browserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url], verbatim: false });
  });

  test("spawns detached and resolves; refuses non-http URLs; spawn failures reject", async () => {
    const calls: unknown[] = [];
    const ok: Spawner = (command, args, options) => {
      calls.push([command, args, options]);
      return { once: () => undefined, unref: () => calls.push("unref") };
    };
    await new SystemBrowserLauncher("win32", ok).open("https://a.example/");
    expect(calls).toEqual([["cmd", ["/c", "start", '""', '"https://a.example/"'], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }], "unref"]);
    await expect(new SystemBrowserLauncher("linux", ok).open("file:///etc/passwd")).rejects.toThrow("refusing to open a non-http(s) URL");
    const throws: Spawner = () => {
      throw new Error("ENOENT");
    };
    await expect(new SystemBrowserLauncher("linux", throws).open("https://a.example/")).rejects.toThrow("ENOENT");
    expect(new SystemBrowserLauncher()).toBeInstanceOf(SystemBrowserLauncher);
  });
});

describe("LoopbackCallbackServer", () => {
  test("binds 127.0.0.1; 404 elsewhere; holds the callback until finish(redirect); 409 afterwards", async () => {
    const server = new LoopbackCallbackServerFactory().create() as LoopbackCallbackServer;
    const port = await server.start("/callback");
    try {
      expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
      const waiting = server.waitForCallback(5000);
      const browser = fetch(`http://127.0.0.1:${port}/callback?code=c&state=s`, { redirect: "manual" });
      expect(await waiting).toEqual({ code: "c", state: "s" });
      await server.finish({ redirect: "https://done.example/" });
      const res = await browser;
      expect([res.status, res.headers.get("location")]).toEqual([302, "https://done.example/"]);
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=s`)).status).toBe(409);
      expect(await server.waitForCallback(1)).toEqual({ code: "c", state: "s" });
    } finally {
      await server.stop();
    }
    await server.stop();
  });

  test("finish with an error text; stop answers a still-held browser request", async () => {
    const server = new LoopbackCallbackServer();
    const port = await server.start("/oauth-callback");
    const browser = fetch(`http://localhost:${port}/oauth-callback?error=access_denied`);
    await server.waitForCallback(5000);
    await server.finish({ status: 400, text: "Sign-in failed" });
    const res = await browser;
    expect([res.status, await res.text()]).toEqual([400, "Sign-in failed"]);
    await server.finish({ redirect: "ignored" });
    const second = new LoopbackCallbackServer();
    const port2 = await second.start("/cb");
    const held = fetch(`http://127.0.0.1:${port2}/cb?code=c`);
    await second.waitForCallback(5000);
    await second.stop();
    expect((await held).status).toBe(500);
    await server.stop();
  });

  test("times out with a named error", async () => {
    const server = new LoopbackCallbackServer();
    await server.start("/cb");
    try {
      await expect(server.waitForCallback(20)).rejects.toBeInstanceOf(CallbackTimeoutError);
    } finally {
      await server.stop();
    }
  });
});

describe("TerminalManualCode", () => {
  test("prints the instruction and reads one line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (c: Buffer) => (printed += c.toString()));
    const answer = new TerminalManualCode(input, output).prompt("https://auth.example/");
    input.write("the-code#state\n");
    expect(await answer).toBe("the-code#state");
    expect(printed).toContain("paste the code");
    expect(printed).not.toContain("https://auth.example/");
    expect(new TerminalManualCode()).toBeInstanceOf(TerminalManualCode);
  });
});

describe("YamlConfigFile", () => {
  test("missing → undefined; Bun.YAML parse with BOM; syntax error → ConfigError; other read errors propagate", async () => {
    const root = temp();
    expect(await new YamlConfigFile(join(root, "router.yaml")).read()).toBeUndefined();
    writeFileSync(join(root, "router.yaml"), "\uFEFFport: 4141\nproviders:\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n");
    expect(await new YamlConfigFile(join(root, "router.yaml")).read()).toEqual({ port: 4141, providers: { antigravity: { enabled: true, acknowledgeTermsRisk: true } } });
    writeFileSync(join(root, "bad.yaml"), "port: [1, 2\n");
    await expect(new YamlConfigFile(join(root, "bad.yaml")).read()).rejects.toBeInstanceOf(ConfigError);
    await expect(new YamlConfigFile(join(root, "x.yaml"), () => { throw "not an error"; }).read()).resolves.toBeUndefined();
    writeFileSync(join(root, "y.yaml"), "a: 1");
    await expect(new YamlConfigFile(join(root, "y.yaml"), () => { throw "not an error"; }).read()).rejects.toThrow("YAML syntax error: not an error");
    mkdirSync(join(root, "dir.yaml"));
    await expect(new YamlConfigFile(join(root, "dir.yaml")).read()).rejects.toHaveProperty("code");
  });
});
