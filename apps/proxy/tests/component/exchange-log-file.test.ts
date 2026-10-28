// The usage log's sink, scope and request-body decoder on the real runtime (plan 2026-10-26 X4–X6, plan 2026-10-27-23-29 L2).
import { describe, expect, test } from "bun:test";
import { recordBody } from "@accounts-proxy/core/domain/exchange-log.ts";
import { LogStreamPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { AsyncExchangeScope, StreamExchangeSink } from "@accounts-proxy/proxy/adapters/outbound/exchange-log-file.ts";
import { NodeHash } from "@accounts-proxy/proxy/adapters/outbound/system.ts";
import { ZstdContentDecoder, ZstdContentEncoder } from "@accounts-proxy/proxy/adapters/outbound/zstd-content-encoder.ts";
import { FixedClock } from "@accounts-proxy/test-support/fakes.ts";

const T = Date.parse("2026-10-26T12:00:00.000Z");

class Lines extends LogStreamPort {
  readonly lines: string[] = [];
  line(text: string) {
    this.lines.push(text);
  }
  async close() {}
}

describe("StreamExchangeSink", () => {
  test("one redacted JSON line per entry, with schema, time and pid", () => {
    const stream = new Lines();
    const clock = new FixedClock(T);
    const sink = new StreamExchangeSink(stream, clock, new NodeHash(), 4242);
    sink.write({ kind: "upstream-request", id: "u-1", url: "https://t/", headers: [["authorization", "Bearer secret-value"]], body: recordBody('{"refresh_token":"rt-1","n":1}') });
    clock.time = T + 1;
    sink.write({ kind: "browser-open", id: "b-1", url: "https://auth/", outcome: "complete" });
    const text = stream.lines.join("\n");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("rt-1");
    const lines = stream.lines.map((line) => JSON.parse(line));
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
    const stream = new Lines();
    const sink = new StreamExchangeSink(stream, new FixedClock(T), new NodeHash(), 1);
    sink.write({ kind: "client-request", id: "c-1", headers: [["x-api-key", "same"]] });
    sink.write({ kind: "client-request", id: "c-2", headers: [["Authorization", "same"]] });
    const [a, b] = stream.lines.map((l) => JSON.parse(l).headers[0][1]);
    expect(a).toBe(b);
  });

  test("best-effort: a stream that throws never reaches the caller (X6)", () => {
    const throwing = new (class extends Lines {
      override line(): void {
        throw new Error("disk gone");
      }
    })();
    expect(() => new StreamExchangeSink(throwing, new FixedClock(T), new NodeHash(), 1).write({ kind: "browser-open", id: "b-1" })).not.toThrow();
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
