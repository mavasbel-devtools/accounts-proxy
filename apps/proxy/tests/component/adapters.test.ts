import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { zstdDecompressSync } from "node:zlib";
import { EMPTY_POOL, TOKEN_ENDPOINT_TIMEOUT_MS, upsertAccount } from "@accounts-proxy/core/domain/accounts.ts";
import { ConfigError } from "@accounts-proxy/core/domain/config.ts";
import { base64UrlEncode } from "@accounts-proxy/core/domain/services/base64url.ts";
import { InvalidRequestError, UpstreamTimeoutError, UpstreamUnreachableError } from "@accounts-proxy/core/domain/errors.ts";
import { readAll, UPSTREAM_IDLE_TIMEOUT_MS } from "@accounts-proxy/core/domain/wire.ts";
import { FixedClock, RecordingLock } from "@accounts-proxy/test-support/fakes.ts";
import { PROXY_LOG, WinstonLogStream } from "@accounts-proxy/proxy/adapters/outbound/log-files.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { browserCommand, SystemBrowserLauncher, type Spawner } from "@accounts-proxy/proxy/adapters/outbound/browser-launcher.ts";
import { FetchTransport, type FetchFunction, type FetchInit } from "@accounts-proxy/proxy/adapters/outbound/fetch-transport.ts";
import { DEFAULT_LOCK_OPTIONS, FileLock, LockTimeoutError, vanishingStatFs } from "@accounts-proxy/proxy/adapters/outbound/file-lock.ts";
import { ACCOUNTS_FILE_SCHEMA, ACCOUNTS_WRITE_ATTEMPTS, AccountsFileChangedError, AccountsFileStore, editedAccountsFs, FileKeyValueStore, FileProxyTokenStore, StoreCorruptError, writeJsonAtomic, type AccountsFileFs } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";
import { CallbackTimeoutError, LoopbackCallbackServer, LoopbackCallbackServerFactory } from "@accounts-proxy/proxy/adapters/outbound/loopback-callback-server.ts";
import { CryptoRandom, NodeHash, StreamLogger, SystemClock, SystemTimer } from "@accounts-proxy/proxy/adapters/outbound/system.ts";
import { TerminalManualCode } from "@accounts-proxy/proxy/adapters/outbound/terminal-manual-code.ts";
import { TerminalSecretPrompt } from "@accounts-proxy/proxy/adapters/outbound/terminal-secret-prompt.ts";
import { YamlConfigFile } from "@accounts-proxy/proxy/adapters/outbound/yaml-config-file.ts";
import { ZstdContentEncoder } from "@accounts-proxy/proxy/adapters/outbound/zstd-content-encoder.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeTemporary(dir);
  dir = undefined;
});
const temp = () => (dir = makeTemporary("proxy-adapters"));
const lockAt = (root: string) => new FileLock(root, new SystemClock(), new SystemTimer(), { ...DEFAULT_LOCK_OPTIONS, pollMs: 2 }, nodeFs);
const credentialStore = (root: string, fs: AccountsFileFs = nodeFs) => new AccountsFileStore(join(root, "accounts.json"), lockAt(root), fs);
const fileOf = (store: AccountsFileStore) => JSON.parse(readFileSync(store.path, "utf8")) as { schema: string; providers: Record<string, unknown> };

describe("file stores", () => {
  test("accounts file: missing → empty; one file for every provider; atomic round trip; 0600; BOM tolerated", async () => {
    const store = credentialStore(temp());
    expect(await store.load("antigravity")).toBe(EMPTY_POOL);
    const pool = upsertAccount(EMPTY_POOL, { provider: "antigravity", id: "me@x", label: "me@x", data: { tokens: { accessToken: "a" } } });
    expect(await store.update("antigravity", () => pool)).toBe(pool);
    const key = upsertAccount(EMPTY_POOL, { provider: "openrouter", id: "k", label: "k", data: { apiKey: "sk" } });
    await store.update("openrouter", () => key);
    expect(await store.load("antigravity")).toEqual(pool);
    expect(fileOf(store)).toEqual({ schema: ACCOUNTS_FILE_SCHEMA, providers: { antigravity: pool, openrouter: key } });
    expect(store.path).toBe(join(dir!, "accounts.json"));
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
    writeFileSync(store.path, `\uFEFF${readFileSync(store.path, "utf8")}`);
    expect(await store.load("antigravity")).toEqual(pool);
    await store.update("antigravity", () => ({ accounts: pool.accounts }));
    expect(await store.load("antigravity")).toEqual({ accounts: pool.accounts });
    await store.update("antigravity", () => ({ accounts: [] }));
    expect(fileOf(store)).toEqual({ schema: ACCOUNTS_FILE_SCHEMA, providers: { openrouter: key } });
  });

  test("update: a change returning the same pool writes nothing; needsLogin round-trips; other keys are kept", async () => {
    const store = credentialStore(temp());
    expect(await store.update("claude", (p) => p)).toBe(EMPTY_POOL);
    expect(() => statSync(store.path)).toThrow();
    writeFileSync(store.path, JSON.stringify({ schema: ACCOUNTS_FILE_SCHEMA, note: "mine", providers: {} }));
    const marked = upsertAccount(EMPTY_POOL, { provider: "claude", id: "a", label: "a", data: {}, needsLogin: "grant rejected" });
    await store.update("claude", () => marked);
    expect(await store.load("claude")).toEqual(marked);
    expect(fileOf(store)).toEqual({ schema: ACCOUNTS_FILE_SCHEMA, note: "mine", providers: { claude: marked } } as never);
  });

  test("update holds across processes: concurrent read-change-writes from two stores lose nothing (H1, A3a)", async () => {
    const root = temp();
    const one = credentialStore(root);
    const two = credentialStore(root);
    const add = (provider: "claude" | "openai", id: string) => (p: typeof EMPTY_POOL) => ({ ...p, accounts: [...p.accounts, { provider, id, label: id, data: {} }] });
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? one : two).update(i % 3 === 0 ? "openai" : "claude", add(i % 3 === 0 ? "openai" : "claude", `acct-${i}`))));
    const ids = [...(await one.load("claude")).accounts, ...(await one.load("openai")).accounts].map((a) => a.id).sort();
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `acct-${i}`).sort());
  });

  test("a hand edit saved between read and rename: the change is applied again to the edited file (A3b)", async () => {
    const store = credentialStore(temp());
    const first = upsertAccount(EMPTY_POOL, { provider: "claude", id: "a", label: "a", data: {} });
    await store.update("claude", () => first);
    let edits = 0;
    const editing: AccountsFileFs = {
      ...nodeFs,
      writeFile: (async (file: string, data: string, options: { encoding: "utf8"; mode: number }) => {
        await nodeFs.writeFile(file, data, options);
        if (edits++ === 0) writeFileSync(store.path, JSON.stringify({ schema: ACCOUNTS_FILE_SCHEMA, providers: { claude: first, openrouter: { accounts: [{ provider: "openrouter", id: "hand", label: "hand", data: { apiKey: "k" } }], activeId: "hand" } } }));
      }) as AccountsFileFs["writeFile"],
    };
    const racing = credentialStore(dir!, editing);
    await racing.update("claude", (p) => upsertAccount(p, { provider: "claude", id: "b", label: "b", data: {} }));
    expect(edits).toBe(2);
    expect((await store.load("openrouter")).activeId).toBe("hand");
    expect((await store.load("claude")).accounts.map((a) => a.id)).toEqual(["a", "b"]);
    expect(readdirSync(dir!).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("an edit during every attempt: AccountsFileChangedError, the file keeps the edit, no temp file is left (A3b)", async () => {
    const store = credentialStore(temp());
    writeFileSync(store.path, JSON.stringify({ schema: ACCOUNTS_FILE_SCHEMA, providers: {} }));
    const racing = credentialStore(dir!, editedAccountsFs(nodeFs, store.path, ACCOUNTS_WRITE_ATTEMPTS));
    await expect(racing.update("claude", (p) => upsertAccount(p, { provider: "claude", id: "b", label: "b", data: {} }))).rejects.toThrow(new AccountsFileChangedError(store.path));
    expect(readFileSync(store.path, "utf8")).toBe(`${JSON.stringify({ schema: ACCOUNTS_FILE_SCHEMA, providers: {} })}${"\n".repeat(ACCOUNTS_WRITE_ATTEMPTS)}`);
    expect(readdirSync(dir!).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const once = credentialStore(dir!, editedAccountsFs(nodeFs, store.path, 1));
    await once.update("claude", (p) => upsertAccount(p, { provider: "claude", id: "c", label: "c", data: {} }));
    expect((await store.load("claude")).activeId).toBe("c");
  });

  test("a failing rename removes the temp file, even when that removal fails too", async () => {
    const store = credentialStore(temp());
    const failing: AccountsFileFs = { ...nodeFs, rename: (() => Promise.reject(new Error("EXDEV"))) as AccountsFileFs["rename"], unlink: (() => Promise.reject(new Error("EPERM"))) as AccountsFileFs["unlink"] };
    await expect(credentialStore(dir!, failing).update("claude", () => upsertAccount(EMPTY_POOL, { provider: "claude", id: "a", label: "a", data: {} }))).rejects.toThrow("EXDEV");
    expect(() => statSync(store.path)).toThrow();
  });

  test("directories the stores, the lock and the log stream create are 0700; lock and log files are 0600", async () => {
    const root = join(temp(), "data");
    await credentialStore(root).update("antigravity", () => ({ accounts: [], activeId: "x" }));
    await new FileKeyValueStore(root, lockAt(root)).write("claude/device-id", "ab");
    await new FileLock(root, new SystemClock(), new SystemTimer(), DEFAULT_LOCK_OPTIONS, nodeFs).withLock("x", async () => {
      if (process.platform !== "win32") expect(statSync(join(root, "locks", "x.lock")).mode & 0o777).toBe(0o600);
    });
    const stream = new WinstonLogStream(join(root, "logs"), PROXY_LOG, 7, 100, () => undefined);
    stream.line("i");
    await stream.close();
    if (process.platform === "win32") return;
    for (const d of [root, join(root, "state"), join(root, "state", "claude"), join(root, "locks"), join(root, "logs")]) expect(statSync(d).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(join(root, "logs")).filter((name) => name.endsWith("-7-proxy.log"));
    expect(statSync(join(root, "logs", file!)).mode & 0o777).toBe(0o600);
  });

  const doc = (providers: string) => `{"schema":"accounts-proxy/accounts/1","providers":${providers}}`;
  test.each([
    ["{oops"],
    ["[]"],
    ['{"providers":{}}'],
    ['{"schema":"other","providers":{}}'],
    ['{"schema":"accounts-proxy/accounts/1","providers":[]}'],
    [doc('{"antigravity":[]}')],
    [doc('{"antigravity":{"accounts":{}}}')],
    [doc('{"antigravity":{"accounts":[{"provider":"claude","id":"x","label":"x","data":{}}]}}')],
    [doc('{"antigravity":{"accounts":[{"provider":"antigravity","id":1,"label":"x","data":{}}]}}')],
    [doc('{"antigravity":{"accounts":[{"provider":"antigravity","id":"x","label":"x","data":{},"needsLogin":1}]}}')],
    [doc('{"antigravity":{"accounts":[],"activeId":1}}')],
  ])("a corrupt accounts file %p is an error, never an empty pool, and is never overwritten", async (content) => {
    const store = credentialStore(temp());
    writeFileSync(store.path, content);
    await expect(store.load("antigravity")).rejects.toBeInstanceOf(StoreCorruptError);
    await expect(store.update("antigravity", () => ({ accounts: [] }))).rejects.toBeInstanceOf(StoreCorruptError);
    expect(readFileSync(store.path, "utf8")).toBe(content);
  });

  test("an unreadable path is not mistaken for a missing file", async () => {
    const store = credentialStore(temp());
    mkdirSync(store.path);
    await expect(store.load("antigravity")).rejects.toHaveProperty("code");
  });

  test("key-value store: nested keys, missing → undefined; every write takes the state lock (W1)", async () => {
    const lock = new RecordingLock();
    const kv = new FileKeyValueStore(temp(), lock);
    expect(await kv.read("claude/device-id")).toBeUndefined();
    await kv.write("claude/device-id", "ab");
    expect(await kv.read("claude/device-id")).toBe("ab");
    expect(kv.path("a/b")).toBe(join(dir!, "state", "a", "b.json"));
    expect(lock.acquired).toEqual(["state"]);
  });

  test("key-value store: BOM tolerated; a corrupt file is StoreCorruptError; other read errors propagate", async () => {
    const kv = new FileKeyValueStore(temp(), new RecordingLock());
    mkdirSync(join(dir!, "state", "claude"), { recursive: true });
    writeFileSync(kv.path("claude/device-id"), '\ufeff"ab"');
    expect(await kv.read("claude/device-id")).toBe("ab");
    writeFileSync(kv.path("claude/device-id"), "{broken");
    await expect(kv.read("claude/device-id")).rejects.toBeInstanceOf(StoreCorruptError);
    mkdirSync(kv.path("claude/session"));
    await expect(kv.read("claude/session")).rejects.toHaveProperty("code", "EISDIR");
  });

  test("atomic write removes its temp file when the rename fails", async () => {
    const root = temp();
    mkdirSync(join(root, "target"));
    await expect(writeJsonAtomic(join(root, "target"), {}, 0o600, nodeFs)).rejects.toBeDefined();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root)).toEqual(["target"]);
    const fs = await import("node:fs/promises");
    const failing = { ...fs, writeFile: (() => Promise.reject(new Error("disk full"))) as unknown as typeof fs.writeFile, unlink: (() => Promise.reject(new Error("ENOENT"))) as unknown as typeof fs.unlink };
    await expect(writeJsonAtomic(join(root, "x.json"), {}, 0o600, failing)).rejects.toThrow("disk full");
  });
});

describe("FileProxyTokenStore", () => {
  test("missing → undefined; created 0600 as JSON under the token lock; read back; corrupt values are errors", async () => {
    const lock = new RecordingLock();
    const store = new FileProxyTokenStore(temp(), lock);
    expect(await store.read()).toBeUndefined();
    expect(await store.createIfAbsent("tok-123")).toBe("tok-123");
    expect(await store.createIfAbsent("tok-other")).toBe("tok-123");
    expect(lock.acquired).toEqual(["token", "token"]);
    expect(store.path()).toBe(join(dir!, "token.json"));
    expect(JSON.parse(readFileSync(store.path(), "utf8"))).toEqual({ token: "tok-123" });
    if (process.platform !== "win32") expect(statSync(store.path()).mode & 0o777).toBe(0o600);
    expect(await store.read()).toBe("tok-123");
    for (const bad of ["[]", '{"token":""}', '{"token":7}']) {
      writeFileSync(store.path(), bad);
      await expect(store.read()).rejects.toBeInstanceOf(StoreCorruptError);
    }
  });
});

describe("FileLock", () => {
  test("serializes holders across instances (two processes' view) and in process", async () => {
    const root = temp();
    const clock = new SystemClock();
    const timer = new SystemTimer();
    const a = new FileLock(root, clock, timer, { ...DEFAULT_LOCK_OPTIONS, pollMs: 5 }, nodeFs);
    const b = new FileLock(root, clock, timer, { ...DEFAULT_LOCK_OPTIONS, pollMs: 5 }, nodeFs);
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

  test("a failing holder releases the lock", async () => {
    const lock = new FileLock(temp(), new SystemClock(), new SystemTimer(), DEFAULT_LOCK_OPTIONS, nodeFs);
    await expect(lock.withLock("x", () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
    expect(await lock.withLock("x", async () => "next")).toBe("next");
  });

  test("a stale lock file is broken; a live one times out", async () => {
    const root = temp();
    mkdirSync(join(root, "locks"));
    const file = join(root, "locks", "x.lock");
    writeFileSync(file, "999 0\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    const lock = new FileLock(root, new SystemClock(), new SystemTimer(), { staleMs: 60_000, timeoutMs: 200, pollMs: 5 }, nodeFs);
    expect(await lock.withLock("x", async () => "broke stale")).toBe("broke stale");
    writeFileSync(file, "999 0\n");
    const started = Date.now();
    await expect(lock.withLock("x", async () => "never")).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("the vanishing-stat hook reports every stat as ENOENT and keeps the other calls", async () => {
    const fs = vanishingStatFs(nodeFs);
    expect(fs.open).toBe(nodeFs.open);
    expect(((await fs.stat("/x").catch((e: unknown) => e)) as NodeJS.ErrnoException).code).toBe("ENOENT");
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
      const transport = new FetchTransport(fetch as unknown as FetchFunction, UPSTREAM_IDLE_TIMEOUT_MS);
      const res = await transport.send({ method: "POST", url: `http://127.0.0.1:${server.port}/echo`, headers: { "x-test": "1" }, body: "hi" });
      expect(res.status).toBe(200);
      expect(res.headers["x-mixed-case"]).toBe("v");
      const it = res.body[Symbol.asyncIterator]();
      expect(new TextDecoder().decode((await it.next()).value)).toBe("first:POST 1 hi");
      release();
      expect(new TextDecoder().decode((await it.next()).value)).toBe("|second");
      const empty = await transport.send({ method: "GET", url: `http://127.0.0.1:${server.port}/empty`, headers: {} });
      expect(await readAll(empty.body)).toBe("");
      const late = await transport.send({ method: "GET", url: `http://127.0.0.1:${server.port}/slow`, headers: {}, timeoutMs: 50 }).catch((e: unknown) => e);
      expect(late).toBeInstanceOf(UpstreamTimeoutError);
      expect((late as UpstreamTimeoutError).message).toBe(`upstream 127.0.0.1:${server.port} sent nothing for 50 ms`);
      const controller = new AbortController();
      const pending = transport.send({ method: "GET", url: `http://127.0.0.1:${server.port}/slow`, headers: {}, signal: controller.signal, timeoutMs: 5_000 });
      controller.abort();
      const aborted = await pending.catch((e: unknown) => e);
      expect((aborted as Error).name).toBe("AbortError");
    } finally {
      server.stop(true);
    }
  });

  const timeoutError = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });

  test("the idle timeout is always explicit; the client signal and the deadline are combined", async () => {
    const inits: FetchInit[] = [];
    const record = async (_url: string, init: FetchInit) => {
      inits.push(init);
      return new Response("ok");
    };
    await new FetchTransport(record, UPSTREAM_IDLE_TIMEOUT_MS).send({ method: "GET", url: "http://127.0.0.1:1/a", headers: {} });
    const controller = new AbortController();
    await new FetchTransport(record, 1234).send({ method: "GET", url: "http://127.0.0.1:1/a", headers: {}, signal: controller.signal });
    expect(inits.map((i) => i.timeout)).toEqual([UPSTREAM_IDLE_TIMEOUT_MS, 1234]);
    expect(inits[0]!.signal!.aborted).toBe(false);
    controller.abort();
    expect(inits[1]!.signal!.aborted).toBe(true);
  });

  test("an idle timeout before or during the body is UpstreamTimeoutError (504); no HTTP answer is UpstreamUnreachableError (502)", async () => {
    const before = new FetchTransport(async () => Promise.reject(timeoutError()), 600_000);
    const early = await before.send({ method: "GET", url: "http://api.example:8443/x", headers: {} }).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(UpstreamTimeoutError);
    expect((early as UpstreamTimeoutError).httpStatus).toBe(504);
    expect((early as UpstreamTimeoutError).message).toBe("upstream api.example:8443 sent nothing for 600000 ms");

    const failing = (error: unknown) =>
      new FetchTransport(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("partial"));
                c.error(error);
              },
            }),
          ),
        1_000,
      );
    const midStream = await failing(timeoutError()).send({ method: "GET", url: "http://h/x", headers: {} });
    await expect(readAll(midStream.body)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    const reset = await failing(new Error("ECONNRESET")).send({ method: "GET", url: "http://h/x", headers: {} });
    await expect(readAll(reset.body)).rejects.toThrow(new UpstreamUnreachableError("h", "Error: ECONNRESET"));
    await expect(new FetchTransport(async () => Promise.reject(new Error("refused")), 1).send({ method: "GET", url: "http://h:9/x", headers: {} })).rejects.toThrow(
      new UpstreamUnreachableError("h:9", "Error: refused"),
    );
    await expect(new FetchTransport(async () => Promise.reject("odd"), 1).send({ method: "GET", url: "http://h/x", headers: {} })).rejects.toThrow(new UpstreamUnreachableError("h", "odd"));
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const gone = new FetchTransport(async () => Promise.reject(abort), 1).send({ method: "GET", url: "http://h/x", headers: {}, signal: controller.signal });
    await expect(gone).rejects.toBe(abort);
    const live = new AbortController();
    await expect(new FetchTransport(async () => Promise.reject(new Error("refused")), 1).send({ method: "GET", url: "http://h/x", headers: {}, signal: live.signal })).rejects.toBeInstanceOf(UpstreamUnreachableError);
  });

  test("a closed local port is UpstreamUnreachableError, measured with the real fetch", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = server.port;
    server.stop(true);
    const error = await new FetchTransport(fetch as FetchFunction, 5_000).send({ method: "GET", url: `http://127.0.0.1:${port}/`, headers: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamUnreachableError);
    expect((error as UpstreamUnreachableError).httpStatus).toBe(502);
  });
});

describe("ZstdContentEncoder (recon gap P1)", () => {
  test("a zstd frame of the UTF-8 body at the default level, as opencode v2.1.1 sends its ChatGPT requests", () => {
    const encoder = new ZstdContentEncoder();
    const body = JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "héllo" }] });
    const frame = encoder.encode(body);
    expect(encoder.encoding).toBe("zstd");
    expect([...frame.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(zstdDecompressSync(frame).toString("utf8")).toBe(body);
  });
});

describe("session invariants (plan v4 H-c)", () => {
  test("a token-endpoint call ends before the renewal lock can be taken over as stale", () => {
    expect(TOKEN_ENDPOINT_TIMEOUT_MS).toBeLessThan(DEFAULT_LOCK_OPTIONS.staleMs);
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

  test("stream logger writes ISO-stamped lines to its stream", () => {
    const lines: string[] = [];
    const logger = new StreamLogger({ line: (text: string) => void lines.push(text), close: async () => undefined }, new FixedClock(0));
    logger.info("i");
    logger.warn("w");
    logger.error("e3", new Error("boom"));
    expect(lines.slice(0, 2)).toEqual(["1970-01-01T00:00:00.000Z INFO i", "1970-01-01T00:00:00.000Z WARN w"]);
    expect(lines[2]).toStartWith("1970-01-01T00:00:00.000Z ERROR e3 :: Error: boom\n    at ");
  });
});

describe("SystemBrowserLauncher", () => {
  test("platform commands: one quoted URL token with verbatim arguments on Windows", () => {
    const url = "https://a.example/?x=1&y=2";
    expect(browserCommand("win32", url)).toEqual({ command: "cmd", args: ["/c", "start", '""', `"${url}"`], verbatim: true });
    expect(browserCommand("darwin", url)).toEqual({ command: "open", args: [url], verbatim: false });
    expect(browserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url], verbatim: false });
  });

  test("spawns detached and resolves; spawn failures reject", async () => {
    const calls: unknown[] = [];
    const ok: Spawner = (command, args, options) => {
      calls.push([command, args, options]);
      return { once: (event: string, listener: (error?: Error) => void) => (event === "spawn" ? listener() : undefined), unref: () => void calls.push("unref") } as ReturnType<Spawner>;
    };
    await new SystemBrowserLauncher("win32", ok).open("https://a.example/");
    expect(calls).toEqual([["cmd", ["/c", "start", '""', '"https://a.example/"'], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }], "unref"]);
    const throws: Spawner = () => {
      throw new Error("ENOENT");
    };
    await expect(new SystemBrowserLauncher("linux", throws).open("https://a.example/")).rejects.toThrow("ENOENT");
    const missing: Spawner = () => ({ once: (event: string, listener: (error: Error) => void) => (event === "error" ? listener(new Error("spawn xdg-open ENOENT")) : undefined), unref: () => undefined }) as ReturnType<Spawner>;
    await expect(new SystemBrowserLauncher("linux", missing).open("https://a.example/")).rejects.toThrow("spawn xdg-open ENOENT");
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
  });

  test("input that ends before a line is an error, not a wait forever", async () => {
    const input = new PassThrough();
    const answer = new TerminalManualCode(input, new PassThrough()).prompt("https://auth.example/");
    input.end();
    await expect(answer).rejects.toThrow("standard input ended before a line was entered");
  });
});

describe("TerminalSecretPrompt (plan P4.6 N4)", () => {
  test("prints the question and reads one line from a pipe; the key is never written to the output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (c: Buffer) => (printed += c.toString()));
    const answer = new TerminalSecretPrompt(input, output).prompt("key: ");
    input.write("oc_sk_secret\n");
    expect(await answer).toBe("oc_sk_secret");
    expect(printed).toBe("key: \n");
  });

  test("on a TTY readline runs in terminal mode and echoes into the discarding stream", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = new PassThrough();
    let printed = "";
    output.on("data", (c: Buffer) => (printed += c.toString()));
    const answer = new TerminalSecretPrompt(input, output).prompt("key: ");
    input.write("sk-typed\r");
    expect(await answer).toBe("sk-typed");
    expect(printed).toBe("key: \n");
  });

  test("input that ends before a line is an error", async () => {
    const input = new PassThrough();
    const answer = new TerminalSecretPrompt(input, new PassThrough()).prompt("key: ");
    input.end();
    await expect(answer).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("YamlConfigFile", () => {
  test("missing → undefined; Bun.YAML parse with BOM; syntax error → ConfigError; other read errors propagate", async () => {
    const root = temp();
    expect(await new YamlConfigFile(join(root, "proxy.yaml")).read()).toBeUndefined();
    writeFileSync(join(root, "proxy.yaml"), "\uFEFFport: 4141\nproviders:\n  antigravity: {enabled: true, acknowledgeTermsRisk: true}\n");
    expect(await new YamlConfigFile(join(root, "proxy.yaml")).read()).toEqual({ port: 4141, providers: { antigravity: { enabled: true, acknowledgeTermsRisk: true } } });
    writeFileSync(join(root, "bad.yaml"), "port: [1, 2\n");
    await expect(new YamlConfigFile(join(root, "bad.yaml")).read()).rejects.toBeInstanceOf(ConfigError);
    writeFileSync(join(root, "y.yaml"), "a: 1");
    await expect(new YamlConfigFile(join(root, "y.yaml"), () => { throw new SyntaxError("parser says no"); }).read()).rejects.toThrow("YAML syntax error: parser says no");
    mkdirSync(join(root, "dir.yaml"));
    await expect(new YamlConfigFile(join(root, "dir.yaml")).read()).rejects.toHaveProperty("code");
  });
});
