// The daemon's socket server over node:http (plan D7). Binds only the given loopback host and port; EADDRINUSE is
// fatal. Request bodies are capped (413). Response bodies are written as they are produced, honouring
// backpressure; a client that disconnects aborts the request's signal, which aborts the upstream exchange. Stop:
// no new connections, idle ones closed, in-flight responses get the grace period, then every connection is destroyed.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { PayloadTooLargeError } from "@accounts-proxy/core/domain/errors.ts";
import type { ErrorReporterPort } from "@accounts-proxy/core/ports/inbound/diagnostics.ts";
import type { HttpHandler, InboundRequest } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import { Server, type Listening } from "@accounts-proxy/proxy/adapters/inbound/server.ts";

/** 32 MB: the documented Messages / Token Counting request limit (anthropic-errors.md §Request size limits), read as
 * decimal megabytes — the smaller reading, so a body the proxy accepts fits the upstream under either reading. */
export const MAX_BODY_BYTES = 32_000_000;

/** While stopping, connections that went idle are closed this often. */
export const STOP_SWEEP_MS = 50;

export class PortInUseError extends Error {
  constructor(readonly host: string, readonly port: number) {
    super(`${host}:${port} is already in use (another accounts-proxy, or another program); choose another port in proxy.yaml`);
    this.name = "PortInUseError";
  }
}

export type NodeHttpServerOptions = { readonly host: string; readonly port: number; readonly maxBodyBytes: number };

/** Lower-cased names; a repeated header is joined with ", " (RFC 9110 §5.3). */
function headersOf(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(message.headersDistinct)) out[name] = values!.join(", ");
  return out;
}

/** `rawHeaders` is a flat [name, value, name, value, ...] list in the order received. */
function rawPairs(raw: readonly string[]): (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
  return pairs;
}

function readBody(message: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(message.headers["content-length"] ?? "0");
  if (declared > limit) {
    message.resume();
    return Promise.reject(new PayloadTooLargeError(limit));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    message.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    message.on("end", () => (size > limit ? reject(new PayloadTooLargeError(limit)) : resolve(Buffer.concat(chunks).toString("utf8"))));
    message.on("error", reject);
  });
}

export class NodeHttpServer extends Server {
  private readonly server: NodeServer;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly handler: HttpHandler,
    private readonly options: NodeHttpServerOptions,
    private readonly errors: ErrorReporterPort,
  ) {
    super();
    this.server = createServer((req, res) => void this.serve(req, res));
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  start(): Promise<Listening> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? new PortInUseError(this.options.host, this.options.port) : error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        const address = this.server.address() as { address: string; port: number };
        resolve({ host: address.address, port: address.port });
      });
    });
  }

  async stop(graceMs: number): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    // A keep-alive connection becomes idle when its in-flight response ends; sweep those until the server is closed.
    this.server.closeIdleConnections();
    const sweep = setInterval(() => this.server.closeIdleConnections(), STOP_SWEEP_MS);
    // Past the grace period every connection is destroyed. (Bun 1.4.2's closeAllConnections leaves a connection with
    // an unfinished response open, measured 2026-10-11; destroying the tracked sockets closes it.)
    const deadline = setTimeout(() => {
      for (const socket of this.sockets) socket.destroy();
    }, graceMs);
    await closed;
    clearInterval(sweep);
    clearTimeout(deadline);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    // A server-side IncomingMessage always carries the request line's method and URL (optional only in the type,
    // which node shares with client responses).
    const url = new URL(`http://127.0.0.1${req.url!}`);
    const request: InboundRequest = {
      method: req.method!,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: headersOf(req),
      rawHeaders: rawPairs(req.rawHeaders),
      readBody: () => readBody(req, this.options.maxBodyBytes),
      signal: controller.signal,
    };
    const response = await this.handler.handle(request);
    res.writeHead(response.status, response.headers);
    try {
      for await (const chunk of response.body) {
        if (controller.signal.aborted) break;
        if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]);
      }
    } catch (error) {
      if (!controller.signal.aborted) this.errors.report(`${request.method} ${request.path}: response stream failed`, error);
    }
    res.end();
  }
}
