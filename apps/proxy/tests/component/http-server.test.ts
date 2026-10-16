// NodeHttpServer on a real loopback socket with scripted handlers: request mapping, streaming order, backpressure,
// client abort → signal, body limits, a busy port, and the shutdown drain.
import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { PayloadTooLargeError } from "@accounts-proxy/core/domain/errors.ts";
import { MemoryLogger } from "@accounts-proxy/test-support/fakes.ts";
import { HttpHandler, type InboundRequest, type OutboundResponse } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import { MAX_BODY_BYTES, NodeHttpServer, PortInUseError } from "@accounts-proxy/proxy/adapters/inbound/http/node-http-server.ts";
import { LoggingErrorReporter } from "@accounts-proxy/proxy/application/error-reporter.ts";

class Scripted extends HttpHandler {
  seen: InboundRequest[] = [];
  constructor(private readonly respond: (request: InboundRequest) => Promise<OutboundResponse>) {
    super();
  }
  handle(request: InboundRequest) {
    this.seen.push(request);
    return this.respond(request);
  }
}

const text = (value: string) => new TextEncoder().encode(value);
async function* once(value: string) {
  yield text(value);
}

let running: NodeHttpServer[] = [];
afterEach(async () => {
  for (const server of running) await server.stop(0);
  running = [];
});

async function serve(respond: (request: InboundRequest) => Promise<OutboundResponse>, maxBodyBytes = MAX_BODY_BYTES) {
  const handler = new Scripted(respond);
  const logger = new MemoryLogger();
  const server = new NodeHttpServer(handler, { host: "127.0.0.1", port: 0, maxBodyBytes }, new LoggingErrorReporter(logger));
  const listening = await server.start();
  running.push(server);
  return { handler, logger, server, url: `http://127.0.0.1:${listening.port}`, listening };
}

describe("NodeHttpServer", () => {
  test("binds 127.0.0.1; maps method, raw path, decoded query, lower-cased (joined) headers and the body", async () => {
    const { handler, url, listening } = await serve(async (request) => ({ status: 201, headers: { "content-type": "text/plain", "x-echo": await request.readBody() }, body: once("done") }));
    expect(listening.host).toBe("127.0.0.1");
    const res = await fetch(`${url}/gemini/v1beta/models/antigravity%2Fg:streamGenerateContent?alt=sse&key=a%20b`, { method: "POST", headers: { "X-Mixed": "1" }, body: "hello" });
    expect([res.status, res.headers.get("x-echo"), await res.text()]).toEqual([201, "hello", "done"]);
    const seen = handler.seen[0]!;
    expect([seen.method, seen.path, seen.query]).toEqual(["POST", "/gemini/v1beta/models/antigravity%2Fg:streamGenerateContent", { alt: "sse", key: "a b" }]);
    expect(seen.headers["x-mixed"]).toBe("1");

    const raw = await new Promise<string>((resolve) => {
      const socket = connect(listening.port, "127.0.0.1");
      let data = "";
      socket.on("data", (d) => (data += String(d)));
      socket.on("close", () => resolve(data));
      socket.write("GET //double/slash HTTP/1.1\r\nHost: x\r\nX-Dup: 1\r\nX-Dup: 2\r\nConnection: close\r\n\r\n");
    });
    expect(raw.startsWith("HTTP/1.1 201")).toBe(true);
    expect([handler.seen[1]!.path, handler.seen[1]!.headers["x-dup"]]).toEqual(["//double/slash", "1, 2"]);
  });

  test("streams: the first chunk reaches the client before the handler produces the second", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url } = await serve(async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: (async function* () {
        yield text("data: 1\n\n");
        await gate;
        yield text("data: 2\n\n");
      })(),
    }));
    const reader = (await fetch(`${url}/s`)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 2\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  test("backpressure: large chunks are written as the client reads", async () => {
    const big = new Uint8Array(4 * 1024 * 1024).fill(97);
    const { url } = await serve(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        for (let i = 0; i < 4; i++) yield big;
      })(),
    }));
    const res = await fetch(`${url}/big`);
    await Bun.sleep(50);
    expect((await res.arrayBuffer()).byteLength).toBe(16 * 1024 * 1024);
  });

  test("a client disconnect aborts the request signal and stops the response stream (no error logged)", async () => {
    let signal!: AbortSignal;
    let stopped = false;
    const { url, logger } = await serve(async (request) => {
      signal = request.signal;
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          try {
            yield text("first");
            for (;;) {
              await Bun.sleep(5);
              if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
              yield text(".");
            }
          } finally {
            stopped = true;
          }
        })(),
      };
    });
    const controller = new AbortController();
    const reader = (await fetch(`${url}/a`, { signal: controller.signal })).body!.getReader();
    await reader.read();
    controller.abort();
    for (let i = 0; i < 100 && !stopped; i++) await Bun.sleep(10);
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(true);
    expect(logger.lines).toEqual([]);
  });

  test("a chunk produced after the client left is not written: the stream is closed instead", async () => {
    const produced: string[] = [];
    let closed = false;
    const { url, logger } = await serve(async (request) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        try {
          yield text("first");
          while (!request.signal.aborted) await Bun.sleep(5);
          produced.push("late");
          yield text("late");
          produced.push("never");
        } finally {
          closed = true;
        }
      })(),
    }));
    const controller = new AbortController();
    const reader = (await fetch(`${url}/late`, { signal: controller.signal })).body!.getReader();
    await reader.read();
    controller.abort();
    for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
    expect(produced).toEqual(["late"]);
    expect(closed).toBe(true);
    expect(logger.lines).toEqual([]);
  });

  test("a response stream that fails is logged and the response is ended", async () => {
    const { url, logger } = await serve(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield text("partial");
        throw new Error("upstream reset");
      })(),
    }));
    expect(await (await fetch(`${url}/f`)).text()).toBe("partial");
    expect(logger.lines).toEqual(["ERROR GET /f: response stream failed Error: upstream reset"]);
  });

  test("bodies past the limit: rejected by content-length, or by size when streamed", async () => {
    const { url } = await serve(async (request) => {
      try {
        return { status: 200, headers: {}, body: once(await request.readBody()) };
      } catch (error) {
        return { status: (error as PayloadTooLargeError).httpStatus, headers: {}, body: once((error as Error).message) };
      }
    }, 10);
    const declared = await fetch(`${url}/b`, { method: "POST", body: "x".repeat(11) });
    expect([declared.status, await declared.text()]).toEqual([413, "request body exceeds 10 bytes"]);
    const streamed = await fetch(`${url}/b`, {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(text("123456"));
          c.enqueue(text("789012"));
          c.close();
        },
      }),
    });
    expect(streamed.status).toBe(413);
    expect(await (await fetch(`${url}/b`, { method: "POST", body: "small" })).text()).toBe("small");
    expect(await (await fetch(`${url}/b`)).text()).toBe("");
  });

  test("a busy port is PortInUseError; another listen failure is passed through", async () => {
    const { listening } = await serve(async () => ({ status: 204, headers: {}, body: once("") }));
    const busy = new NodeHttpServer(new Scripted(async () => ({ status: 204, headers: {}, body: once("") })), { host: "127.0.0.1", port: listening.port, maxBodyBytes: 1 }, new LoggingErrorReporter(new MemoryLogger()));
    const error = await busy.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortInUseError);
    expect((error as PortInUseError).message).toBe(`127.0.0.1:${listening.port} is already in use (another accounts-proxy, or another program); choose another port in proxy.yaml`);
    const foreign = new NodeHttpServer(new Scripted(async () => ({ status: 204, headers: {}, body: once("") })), { host: "203.0.113.1", port: 0, maxBodyBytes: 1 }, new LoggingErrorReporter(new MemoryLogger()));
    expect(((await foreign.start().catch((e: unknown) => e)) as NodeJS.ErrnoException).code).toBe("EADDRNOTAVAIL");
  });

  test("stop: an in-flight response finishes inside the grace period; past it, connections are closed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const finishing = await serve(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield text("a");
        await gate;
        yield text("b");
      })(),
    }));
    const res = await fetch(`${finishing.url}/x`);
    const stopping = finishing.server.stop(5_000);
    release();
    expect(await res.text()).toBe("ab");
    await stopping;
    running = running.filter((s) => s !== finishing.server);

    const hanging = await serve(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield text("a");
        await new Promise(() => undefined);
      })(),
    }));
    const stuck = await fetch(`${hanging.url}/x`);
    const started = performance.now();
    await hanging.server.stop(50);
    expect(performance.now() - started).toBeLessThan(2_000);
    await stuck.text().catch(() => undefined);
    running = running.filter((s) => s !== hanging.server);
  });
});
