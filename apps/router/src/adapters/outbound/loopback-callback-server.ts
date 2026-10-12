// RFC 8252 §7.3 loopback redirect listener, modelled on the official Claude Code 2.1.280 listener (P0-E6 §1.5):
// binds 127.0.0.1 on an ephemeral port, answers 404 for any other path, and HOLDS the browser's request on the
// callback path until the login outcome is known (`finish`: 302 to the provider's success page, or an error text).
// Only the first callback is accepted; later ones get 409.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CallbackServerFactoryPort, CallbackServerPort, type CallbackQuery } from "@inference-router/core/ports/outbound/oauth.ts";

export class CallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no browser callback within ${Math.round(timeoutMs / 1000)} s`);
    this.name = "CallbackTimeoutError";
  }
}

export class LoopbackCallbackServer extends CallbackServerPort {
  private server: Server | undefined;
  private path = "/";
  private pending: ServerResponse | undefined;
  private received: CallbackQuery | undefined;
  private settle!: (query: CallbackQuery) => void;
  /** Settled by the first callback, whenever it arrives (before or after waitForCallback is called). */
  private readonly callback = new Promise<CallbackQuery>((resolve) => (this.settle = resolve));

  async start(path: string): Promise<number> {
    this.path = path;
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    return (server.address() as { port: number }).port;
  }

  waitForCallback(timeoutMs: number): Promise<CallbackQuery> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CallbackTimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([this.callback, timeout]).finally(() => clearTimeout(timer));
  }

  async finish(answer: { readonly redirect: string } | { readonly status: number; readonly text: string }): Promise<void> {
    const res = this.pending;
    this.pending = undefined;
    if (res === undefined) return;
    if ("redirect" in answer) res.writeHead(302, { location: answer.redirect });
    else res.writeHead(answer.status, { "content-type": "text/plain; charset=utf-8" });
    await new Promise<void>((resolve) => res.end("text" in answer ? answer.text : "", resolve));
  }

  /** Only after a successful start (the caller starts before it can need a stop). */
  async stop(): Promise<void> {
    await this.finish({ status: 500, text: "Sign-in was interrupted. Close this tab and retry." });
    const server = this.server!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // `url` is always set on requests received by an http.Server (Node docs: "Only valid for request obtained
    // from http.Server"); the type is optional only because IncomingMessage also models client responses.
    const url = new URL(req.url as string, "http://localhost");
    if (url.pathname !== this.path) {
      res.writeHead(404).end();
      return;
    }
    if (this.received !== undefined) {
      res.writeHead(409, { "content-type": "text/plain; charset=utf-8" }).end("This sign-in was already completed.");
      return;
    }
    this.received = Object.fromEntries(url.searchParams);
    this.pending = res;
    this.settle(this.received);
  }
}

export class LoopbackCallbackServerFactory extends CallbackServerFactoryPort {
  create(): CallbackServerPort {
    return new LoopbackCallbackServer();
  }
}
