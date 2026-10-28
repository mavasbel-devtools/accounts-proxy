// The exchange log's file, scope and request-body decoder on the real filesystem and runtime (plan 2026-10-26 X1, X4–X6).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordBody } from "@accounts-proxy/core/domain/exchange-log.ts";
import { AsyncExchangeScope, FileExchangeSink } from "@accounts-proxy/proxy/adapters/outbound/exchange-log-file.ts";
import { NodeHash } from "@accounts-proxy/proxy/adapters/outbound/system.ts";
import { ZstdContentDecoder, ZstdContentEncoder } from "@accounts-proxy/proxy/adapters/outbound/zstd-content-encoder.ts";
import { FixedClock } from "@accounts-proxy/test-support/fakes.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeTemporary(dir);
  dir = undefined;
});

const DAY = 86_400_000;
const T = Date.parse("2026-10-26T12:00:00.000Z");

describe("FileExchangeSink", () => {
  test("one redacted JSON line per entry in the UTC day file (0600 in a 0700 directory), with schema, time and pid", () => {
    dir = makeTemporary("exchange-log");
    const logs = join(dir, "logs");
    const clock = new FixedClock(T);
    const sink = new FileExchangeSink(logs, clock, new NodeHash(), 14, 4242);
    sink.write({ kind: "upstream-request", id: "u-1", url: "https://t/", headers: [["authorization", "Bearer secret-value"]], body: recordBody('{"refresh_token":"rt-1","n":1}') });
    clock.time = T + 1;
    sink.write({ kind: "browser-open", id: "b-1", url: "https://auth/", outcome: "complete" });
    const file = join(logs, "exchanges-2026-10-26.jsonl");
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("rt-1");
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      schema: "accounts-proxy-exchange/1",
      at: "2026-10-26T12:00:00.000Z",
      pid: 4242,
      kind: "upstream-request",
      id: "u-1",
      url: "https://t/",
      headers: [["authorization", expect.stringMatching(/^\[redacted sha256:[0-9a-f]{12} len:19\]$/)]],
      body: { encoding: "utf8", text: expect.stringMatching(/^\{"refresh_token":"\[redacted sha256:[0-9a-f]{12} len:4\]","n":1\}$/), bytes: 30 },
    });
    expect(lines[1]).toEqual({ schema: "accounts-proxy-exchange/1", at: "2026-10-26T12:00:00.001Z", pid: 4242, kind: "browser-open", id: "b-1", url: "https://auth/", outcome: "complete" });
  });

  test("the same credential has the same fingerprint in every entry", () => {
    dir = makeTemporary("exchange-log");
    const sink = new FileExchangeSink(dir, new FixedClock(T), new NodeHash(), 14, 1);
    sink.write({ kind: "client-request", id: "c-1", headers: [["x-api-key", "same"]] });
    sink.write({ kind: "client-request", id: "c-2", headers: [["Authorization", "same"]] });
    const [a, b] = readFileSync(join(dir, "exchanges-2026-10-26.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l).headers[0][1]);
    expect(a).toBe(b);
  });

  test("retention: at the first write of a day, day files older than retentionDays (today included) are deleted; other files stay", () => {
    dir = makeTemporary("exchange-log");
    mkdirSync(dir, { recursive: true });
    for (const name of ["exchanges-2026-10-23.jsonl", "exchanges-2026-10-24.jsonl", "exchanges-2026-10-25.jsonl", "proxy.log", "exchanges-notes.txt"]) writeFileSync(join(dir, name), "x\n");
    const clock = new FixedClock(T);
    const sink = new FileExchangeSink(dir, clock, new NodeHash(), 2, 1);
    sink.write({ kind: "browser-open", id: "b-1" });
    expect(readdirSync(dir).sort()).toEqual(["exchanges-2026-10-25.jsonl", "exchanges-2026-10-26.jsonl", "exchanges-notes.txt", "proxy.log"]);
    // Same day: no new pruning, even if an old file reappears.
    writeFileSync(join(dir, "exchanges-2026-10-01.jsonl"), "x\n");
    sink.write({ kind: "browser-open", id: "b-2" });
    expect(existsSync(join(dir, "exchanges-2026-10-01.jsonl"))).toBe(true);
    // Next day: pruned again; the 25th is now outside two days.
    clock.time = T + DAY;
    sink.write({ kind: "browser-open", id: "b-3" });
    expect(readdirSync(dir).sort()).toEqual(["exchanges-2026-10-26.jsonl", "exchanges-2026-10-27.jsonl", "exchanges-notes.txt", "proxy.log"]);
  });

  test("best-effort: a directory that cannot be created never throws (X6)", () => {
    dir = makeTemporary("exchange-log");
    const blocker = join(dir, "file");
    writeFileSync(blocker, "not a directory");
    const sink = new FileExchangeSink(join(blocker, "logs"), new FixedClock(T), new NodeHash(), 14, 1);
    expect(() => sink.write({ kind: "browser-open", id: "b-1" })).not.toThrow();
  });
});

describe("AsyncExchangeScope", () => {
  test("follows the asynchronous work of each exchange; nested and concurrent runs keep their own id; outside: undefined", async () => {
    const scope = new AsyncExchangeScope();
    expect(scope.current()).toBeUndefined();
    const seen: (string | undefined)[] = [];
    const work = (id: string, delay: number) =>
      scope.run(id, async () => {
        await Bun.sleep(delay);
        seen.push(scope.current());
        return scope.run(`${id}-inner`, async () => scope.current());
      });
    expect(await Promise.all([work("a", 20), work("b", 5)])).toEqual(["a-inner", "b-inner"]);
    expect(seen).toEqual(["b", "a"]);
    expect(scope.current()).toBeUndefined();
  });
});

describe("ZstdContentDecoder", () => {
  test("names zstd and decodes what the encoder produced", () => {
    const decoder = new ZstdContentDecoder();
    expect(decoder.encoding).toBe("zstd");
    expect(decoder.decode(new ZstdContentEncoder().encode('{"a":"é"}'))).toBe('{"a":"é"}');
  });
});
