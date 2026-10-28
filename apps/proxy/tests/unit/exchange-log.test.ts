// The exchange log's recording (plan 2026-10-26 X1–X3, X6): the client side (service + HTTP decorator), the upstream
// side (transport decorator) and the login's browser page and loopback callback.
import { describe, expect, test } from "bun:test";
import { orderedHeaders, type HttpRequest } from "@accounts-proxy/core/domain/wire.ts";
import { CallbackServerFactoryPort, CallbackServerPort, type CallbackQuery } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import { BrowserLauncherPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { ContentDecoderPort, HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { HttpHandler, type InboundRequest, type OutboundResponse } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import { LoggingHttpHandler } from "@accounts-proxy/proxy/adapters/inbound/http/logging-http-handler.ts";
import { LoggingBrowserLauncher, LoggingCallbackServerFactory } from "@accounts-proxy/proxy/adapters/outbound/logging-login.ts";
import { LoggingTransport } from "@accounts-proxy/proxy/adapters/outbound/logging-transport.ts";
import { ClientExchangeService } from "@accounts-proxy/proxy/application/client-exchange-service.ts";
import { chunks, collect, FixedClock, MemoryExchangeSink, ScriptedTransport, SequenceRandom, StackExchangeScope } from "@accounts-proxy/test-support/fakes.ts";

/** A clock that advances 5 ms on every reading, so each recorded time is distinct and predictable. */
class TickingClock extends FixedClock {
  override now(): number {
    this.time += 5;
    return this.time;
  }
}

const T0 = 1_800_000_000_000;

function client(handler: (request: InboundRequest) => Promise<OutboundResponse>) {
  const sink = new MemoryExchangeSink();
  const scope = new StackExchangeScope();
  class Inner extends HttpHandler {
    seenScope: (string | undefined)[] = [];
    async handle(request: InboundRequest): Promise<OutboundResponse> {
      this.seenScope.push(scope.current());
      return handler(request);
    }
  }
  const inner = new Inner();
  const logging = new LoggingHttpHandler(inner, new ClientExchangeService(sink, scope, new TickingClock(T0), new SequenceRandom()));
  return { sink, inner, logging };
}

const inbound = (over: Partial<InboundRequest> = {}): InboundRequest => ({
  method: "POST",
  path: "/v1/messages",
  query: { beta: "true" },
  headers: { authorization: "Bearer T" },
  rawHeaders: [["Authorization", "Bearer T"], ["X-Trace", "1"]],
  readBody: async () => '{"model":"claude/m"}',
  signal: new AbortController().signal,
  ...over,
});

describe("client exchanges (LoggingHttpHandler + ClientExchangeService)", () => {
  test("a streamed answer: request record with the headers as sent, response record with chunks, usage and timings", async () => {
    const c = client(async (request) => {
      await request.readBody();
      return { status: 200, headers: { "content-type": "text/event-stream" }, body: chunks(['data: {"usage":{"input_tokens":3}}\n\n', 'data: {"usage":{"output_tokens":9}}\n\n']) };
    });
    const response = await c.logging.handle(inbound());
    expect(c.inner.seenScope).toEqual(["c-uuid-1"]);
    expect(await collect(response.body)).toHaveLength(2);
    expect(c.sink.entries).toEqual([
      {
        kind: "client-request",
        id: "c-uuid-1",
        startedAt: new Date(T0 + 5).toISOString(),
        method: "POST",
        path: "/v1/messages",
        query: { beta: "true" },
        headers: [["Authorization", "Bearer T"], ["X-Trace", "1"]],
        body: { encoding: "utf8", text: '{"model":"claude/m"}', bytes: 20 },
      },
      {
        kind: "client-response",
        id: "c-uuid-1",
        status: 200,
        headers: [["content-type", "text/event-stream"]],
        body: { encoding: "utf8", text: 'data: {"usage":{"input_tokens":3}}\n\ndata: {"usage":{"output_tokens":9}}\n\n', bytes: 73 },
        chunks: [
          { t: 15, bytes: 36 },
          { t: 20, bytes: 37 },
        ],
        usage: { raw: { input_tokens: 3, output_tokens: 9 }, tokens: { input: 3, output: 9 } },
        outcome: "complete",
        timing: { startedAt: new Date(T0 + 5).toISOString(), requestBodyMs: 5, headersMs: 10, firstByteMs: 15, totalMs: 25 },
      },
    ]);
  });

  test("a route that never reads the body: the request record is written with the answer; no usage, no chunks", async () => {
    const c = client(async () => ({ status: 404, headers: {}, body: chunks([]) }));
    await collect((await c.logging.handle(inbound({ method: "GET", path: "/x" }))).body);
    expect(c.sink.entries.map((e) => [e.kind, e["body"]])).toEqual([
      ["client-request", { encoding: "utf8", text: "", bytes: 0 }],
      ["client-response", { encoding: "utf8", text: "", bytes: 0 }],
    ]);
    expect(c.sink.entries[1]!["timing"]).toEqual({ startedAt: new Date(T0 + 5).toISOString(), headersMs: 5, totalMs: 10 });
    expect(c.sink.entries[1]!["usage"]).toBeUndefined();
  });

  test("a body that fails to read: recorded with its error; reading twice records once", async () => {
    const c = client(async (request) => {
      await request.readBody().catch(() => undefined);
      await request.readBody().catch(() => undefined);
      return { status: 413, headers: {}, body: chunks(["too large"]) };
    });
    await collect((await c.logging.handle(inbound({ readBody: async () => Promise.reject(new Error("PayloadTooLarge")) }))).body);
    expect(c.sink.entries.filter((e) => e.kind === "client-request")).toEqual([
      expect.objectContaining({ body: { encoding: "utf8", text: "", bytes: 0 }, error: "Error: PayloadTooLarge" }),
    ]);
  });

  test("the client goes away mid-stream: outcome aborted and the source is released; a failing body: outcome failed", async () => {
    const abort = new AbortController();
    let released = false;
    async function* endless(): AsyncIterable<Uint8Array> {
      try {
        for (;;) yield new TextEncoder().encode("x");
      } finally {
        released = true;
      }
    }
    const a = client(async () => ({ status: 200, headers: {}, body: endless() }));
    const response = await a.logging.handle(inbound({ signal: abort.signal }));
    for await (const _ of response.body) {
      abort.abort();
      break;
    }
    expect(released).toBe(true);
    expect(a.sink.entries.at(-1)).toEqual(expect.objectContaining({ kind: "client-response", outcome: "aborted" }));

    async function* failing(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("a");
      throw new Error("upstream reset");
    }
    const f = client(async () => ({ status: 200, headers: {}, body: failing() }));
    await expect(collect((await f.logging.handle(inbound())).body)).rejects.toThrow("upstream reset");
    expect(f.sink.entries.at(-1)).toEqual(expect.objectContaining({ outcome: "failed", error: "Error: upstream reset" }));

    const g = client(async () => ({ status: 200, headers: {}, body: failing() }));
    const gone = new AbortController();
    gone.abort();
    await expect(collect((await g.logging.handle(inbound({ signal: gone.signal }))).body)).rejects.toThrow("upstream reset");
    expect(g.sink.entries.at(-1)).toEqual(expect.objectContaining({ outcome: "aborted", error: "Error: upstream reset" }));

    const h = client(async () => ({ status: 200, headers: {}, body: chunks(["a"]) }));
    const late = new AbortController();
    const done = await h.logging.handle(inbound({ signal: late.signal }));
    late.abort();
    await collect(done.body);
    expect(h.sink.entries.at(-1)).toEqual(expect.objectContaining({ outcome: "aborted" }));
  });

  test("a non-UTF-8 answer is kept as base64 and has no usage", async () => {
    const c = client(async () => ({ status: 200, headers: {}, body: (async function* () { yield new Uint8Array([0xff]); })() }));
    await collect((await c.logging.handle(inbound())).body);
    expect(c.sink.entries.at(-1)).toEqual(expect.objectContaining({ body: { encoding: "base64", text: "/w==", bytes: 1 } }));
    expect(c.sink.entries.at(-1)!["usage"]).toBeUndefined();
  });
});

class Decoder extends ContentDecoderPort {
  readonly encoding = "zstd";
  decode(body: Uint8Array): string {
    return `decoded ${body.length} bytes`;
  }
}

function upstream(transport: HttpTransportPort) {
  const sink = new MemoryExchangeSink();
  const scope = new StackExchangeScope();
  return { sink, scope, logging: new LoggingTransport(transport, sink, scope, new TickingClock(T0), new SequenceRandom(), new Decoder()) };
}

describe("upstream exchanges (LoggingTransport)", () => {
  test("inside a client exchange: request (headers in order, decoded zstd body, timeout) and response (usage, chunks, timings)", async () => {
    const scripted = new ScriptedTransport(() => ({ status: 200, headers: { "request-id": "r1" }, body: ['{"usage":', '{"prompt_tokens":4}}'] }));
    const u = upstream(scripted);
    const request: HttpRequest = { method: "POST", url: "https://api/v1", headers: orderedHeaders([["Content-Encoding", "zstd"], ["authorization", "Bearer x"]]), body: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), timeoutMs: 30_000 };
    const text = await u.scope.run("c-1", async () => (await collect((await u.logging.send(request)).body)).join(""));
    expect(text).toBe('{"usage":{"prompt_tokens":4}}');
    expect(scripted.requests).toEqual([request]);
    expect(u.sink.entries).toEqual([
      {
        kind: "upstream-request",
        id: "u-uuid-1",
        exchange: "c-1",
        startedAt: new Date(T0 + 5).toISOString(),
        method: "POST",
        url: "https://api/v1",
        headers: [["Content-Encoding", "zstd"], ["authorization", "Bearer x"]],
        body: { encoding: "base64", text: "KLUv/Q==", bytes: 4 },
        decodedBody: "decoded 4 bytes",
        timeoutMs: 30_000,
      },
      {
        kind: "upstream-response",
        id: "u-uuid-1",
        exchange: "c-1",
        status: 200,
        headers: [["request-id", "r1"]],
        body: { encoding: "utf8", text: '{"usage":{"prompt_tokens":4}}', bytes: 29 },
        chunks: [
          { t: 10, bytes: 9 },
          { t: 15, bytes: 20 },
        ],
        usage: { raw: { prompt_tokens: 4 }, tokens: { input: 4 } },
        outcome: "complete",
        timing: { startedAt: new Date(T0 + 5).toISOString(), headersMs: 5, firstByteMs: 10, totalMs: 20 },
      },
    ]);
  });

  test("outside a client exchange (a command's own call): no exchange link; a text body; another encoding is not decoded", async () => {
    const u = upstream(new ScriptedTransport(() => ({ status: 204 })));
    await collect((await u.logging.send({ method: "POST", url: "https://t", headers: { "content-encoding": "gzip" }, body: "a=1" })).body);
    await collect((await u.logging.send({ method: "GET", url: "https://t", headers: { "content-encoding": "zstd" } })).body);
    expect(u.sink.entries.map((e) => [e.kind, "exchange" in e, e["body"]])).toEqual([
      ["upstream-request", false, { encoding: "utf8", text: "a=1", bytes: 3 }],
      ["upstream-response", false, { encoding: "utf8", text: "", bytes: 0 }],
      ["upstream-request", false, { encoding: "utf8", text: "", bytes: 0 }],
      ["upstream-response", false, { encoding: "utf8", text: "", bytes: 0 }],
    ]);
    // ScriptedTransport sends an empty body as one empty chunk
    expect(u.sink.entries[1]!["timing"]).toEqual({ startedAt: new Date(T0 + 5).toISOString(), headersMs: 5, firstByteMs: 10, totalMs: 15 });
  });

  test("a call that fails, a body that fails, a body the caller abandons, and a binary answer", async () => {
    class Failing extends HttpTransportPort {
      async send(): Promise<never> {
        throw new Error("ECONNREFUSED");
      }
    }
    const failed = upstream(new Failing());
    await expect(failed.logging.send({ method: "GET", url: "https://t", headers: {} })).rejects.toThrow("ECONNREFUSED");
    expect(failed.sink.entries.at(-1)).toEqual({ kind: "upstream-response", id: "u-uuid-1", outcome: "failed", error: "Error: ECONNREFUSED", timing: { startedAt: new Date(T0 + 5).toISOString(), totalMs: 5 } });

    const broken = upstream(
      new ScriptedTransport(() => ({
        status: 200,
        body: () =>
          (async function* () {
            yield new TextEncoder().encode("a");
            throw new Error("idle timeout");
          })(),
      })),
    );
    await expect(collect((await broken.logging.send({ method: "GET", url: "https://t", headers: {} })).body)).rejects.toThrow("idle timeout");
    expect(broken.sink.entries.at(-1)).toEqual(expect.objectContaining({ outcome: "failed", error: "Error: idle timeout" }));

    const left = upstream(new ScriptedTransport(() => ({ status: 200, body: ["a", "b"] })));
    for await (const _ of (await left.logging.send({ method: "GET", url: "https://t", headers: {} })).body) break;
    expect(left.sink.entries.at(-1)).toEqual(expect.objectContaining({ outcome: "aborted", chunks: [{ t: 10, bytes: 1 }] }));

    const silent = upstream(new ScriptedTransport(() => ({ status: 204, body: () => (async function* () {})() })));
    await collect((await silent.logging.send({ method: "GET", url: "https://t", headers: {} })).body);
    expect(silent.sink.entries.at(-1)!["timing"]).toEqual({ startedAt: new Date(T0 + 5).toISOString(), headersMs: 5, totalMs: 10 });

    const binary = upstream(new ScriptedTransport(() => ({ status: 200, body: () => (async function* () { yield new Uint8Array([0xfe]); })() })));
    await collect((await binary.logging.send({ method: "GET", url: "https://t", headers: {} })).body);
    expect(binary.sink.entries.at(-1)).toEqual(expect.objectContaining({ body: { encoding: "base64", text: "/g==", bytes: 1 } }));
    expect(binary.sink.entries.at(-1)!["usage"]).toBeUndefined();
  });
});

describe("login exchanges (browser page and loopback callback)", () => {
  class Browser extends BrowserLauncherPort {
    constructor(private readonly fail: boolean) {
      super();
    }
    async open(): Promise<void> {
      if (this.fail) throw new Error("no browser");
    }
  }
  class Server extends CallbackServerPort {
    readonly calls: string[] = [];
    constructor(private readonly callback: CallbackQuery | Error) {
      super();
    }
    async start(path: string): Promise<number> {
      this.calls.push(`start ${path}`);
      return 51234;
    }
    async waitForCallback(): Promise<CallbackQuery> {
      if (this.callback instanceof Error) throw this.callback;
      return this.callback;
    }
    async finish(answer: { readonly redirect: string } | { readonly status: number; readonly text: string }): Promise<void> {
      this.calls.push(`finish ${JSON.stringify(answer)}`);
    }
    async stop(): Promise<void> {
      this.calls.push("stop");
    }
  }
  class Factory extends CallbackServerFactoryPort {
    constructor(readonly server: Server) {
      super();
    }
    create(): CallbackServerPort {
      return this.server;
    }
  }

  test("browser-open: the URL, opened or failed", async () => {
    const sink = new MemoryExchangeSink();
    await new LoggingBrowserLauncher(new Browser(false), sink, new SequenceRandom()).open("https://auth/?a=1");
    await expect(new LoggingBrowserLauncher(new Browser(true), sink, new SequenceRandom()).open("https://auth/")).rejects.toThrow("no browser");
    expect(sink.entries).toEqual([
      { kind: "browser-open", id: "b-uuid-1", url: "https://auth/?a=1", outcome: "complete" },
      { kind: "browser-open", id: "b-uuid-1", url: "https://auth/", outcome: "failed", error: "Error: no browser" },
    ]);
  });

  test("login-callback: answered by redirect or by text, and a wait that fails", async () => {
    const run = async (callback: CallbackQuery | Error, answer?: { readonly redirect: string } | { readonly status: number; readonly text: string }) => {
      const sink = new MemoryExchangeSink();
      const inner = new Server(callback);
      const server = new LoggingCallbackServerFactory(new Factory(inner), sink, new TickingClock(T0), new SequenceRandom()).create();
      expect(await server.start("/callback")).toBe(51234);
      try {
        await server.waitForCallback(1000);
        if (answer !== undefined) await server.finish(answer);
      } catch {
        // recorded
      }
      await server.stop();
      return { sink, inner };
    };
    const redirected = await run({ code: "c", state: "s" }, { redirect: "https://ok" });
    expect(redirected.inner.calls).toEqual(["start /callback", 'finish {"redirect":"https://ok"}', "stop"]);
    expect(redirected.sink.entries).toEqual([
      {
        kind: "login-callback",
        id: "l-uuid-1",
        url: "http://127.0.0.1:51234/callback",
        query: { code: "c", state: "s" },
        outcome: "complete",
        answer: "302 https://ok",
        timing: { startedAt: new Date(T0 + 5).toISOString(), callbackMs: 5, totalMs: 10 },
      },
    ]);
    expect((await run({ error: "access_denied" }, { status: 400, text: "denied" })).sink.entries[0]).toEqual(expect.objectContaining({ answer: "400 denied" }));
    // A callback the login never answered (it was interrupted) leaves no record: the sign-in itself failed loudly.
    expect((await run({ code: "c" })).sink.entries).toEqual([]);
    const timedOut = await run(new Error("timed out"));
    expect(timedOut.sink.entries).toEqual([
      { kind: "login-callback", id: "l-uuid-1", url: "http://127.0.0.1:51234/callback", outcome: "failed", error: "Error: timed out", timing: { startedAt: new Date(T0 + 5).toISOString(), totalMs: 5 } },
    ]);
  });
});
