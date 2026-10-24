// A loopback TCP tap in front of the replay upstream. It forwards bytes unchanged in both directions and parses the
// client→server bytes as HTTP/1.1, so plane B keeps what an HTTP server object hides: header order, header case and
// duplicates, exactly as the proxy's HTTP stack put them on the wire.
import { connect, createServer, type Server, type Socket } from "node:net";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import type { WireRequest } from "@accounts-proxy/scripts/recon/parity/canon.ts";

export type TappedRequest = WireRequest & { readonly connection: number };

/** Incremental HTTP/1.1 request parser over one connection's client→server bytes. */
export class RequestStream {
  private buffer = Buffer.alloc(0);

  constructor(private readonly emit: (request: Omit<TappedRequest, "connection">) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = this.next();
      if (parsed === undefined) return;
      this.emit(parsed);
    }
  }

  private next(): Omit<TappedRequest, "connection"> | undefined {
    const end = this.buffer.indexOf("\r\n\r\n");
    if (end < 0) return undefined;
    const lines = this.buffer.subarray(0, end).toString("latin1").split("\r\n");
    const [method = "", target = "", httpVersion = ""] = (lines[0] ?? "").split(" ");
    const headers = lines.slice(1).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
    });
    const find = (name: string) => headers.find(([key]) => key.toLowerCase() === name)?.[1];
    const start = end + 4;
    let body: Buffer;
    let consumed: number;
    if ((find("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
      const chunks: Buffer[] = [];
      let at = start;
      for (;;) {
        const lineEnd = this.buffer.indexOf("\r\n", at);
        if (lineEnd < 0) return undefined;
        const size = Number.parseInt(this.buffer.subarray(at, lineEnd).toString("latin1").split(";")[0]!, 16);
        if (Number.isNaN(size)) throw new Error("tap: malformed chunk size");
        const dataStart = lineEnd + 2;
        if (size === 0) {
          const trailerEnd = this.buffer.indexOf("\r\n\r\n", lineEnd);
          if (trailerEnd < 0) return undefined;
          consumed = trailerEnd + 4;
          break;
        }
        if (this.buffer.length < dataStart + size + 2) return undefined;
        chunks.push(this.buffer.subarray(dataStart, dataStart + size));
        at = dataStart + size + 2;
      }
      body = Buffer.concat(chunks);
    } else {
      const length = Number(find("content-length") ?? "0");
      if (this.buffer.length < start + length) return undefined;
      body = this.buffer.subarray(start, start + length);
      consumed = start + length;
    }
    this.buffer = this.buffer.subarray(consumed);
    // Plane A holds the decoded body (the capture addon decodes `content-encoding`); the header itself is compared.
    const encoding = (find("content-encoding") ?? "").toLowerCase();
    const decoded = encoding === "zstd" ? zstdDecompressSync(body) : encoding === "gzip" ? gunzipSync(body) : body;
    return { method, url: target, httpVersion, headers, body: decoded.toString("utf8") };
  }
}

export class WireTap {
  readonly requests: TappedRequest[] = [];
  private server: Server | undefined;
  private connections = 0;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly targetPort: number) {}

  async start(): Promise<number> {
    this.server = createServer((client) => {
      const id = (this.connections += 1);
      const upstream = connect(this.targetPort, "127.0.0.1");
      this.sockets.add(client).add(upstream);
      const parser = new RequestStream((request) => this.requests.push({ ...request, connection: id }));
      client.on("data", (chunk: Buffer) => {
        parser.push(chunk);
        upstream.write(chunk);
      });
      upstream.on("data", (chunk: Buffer) => client.write(chunk));
      const close = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("close", close).on("error", close);
      upstream.on("close", close).on("error", close);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("tap: no port");
    return address.port;
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
  }
}
