// The login's own HTTP exchanges in the exchange log (plan 2026-10-26 X1): the page the browser is sent to
// (`browser-open`, the full authorization URL) and the loopback callback the browser brings back (`login-callback`: its
// query, the time it arrived and the answer the browser got). The grant code and every credential are redacted by the sink.
import type { ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import { CallbackServerFactoryPort, CallbackServerPort, type CallbackQuery } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import { BrowserLauncherPort, type ClockPort, type RandomPort } from "@accounts-proxy/core/ports/outbound/system.ts";

type FinishAnswer = Parameters<CallbackServerPort["finish"]>[0];

export class LoggingBrowserLauncher extends BrowserLauncherPort {
  constructor(
    private readonly inner: BrowserLauncherPort,
    private readonly sink: ExchangeSinkPort,
    private readonly random: RandomPort,
  ) {
    super();
  }

  async open(url: string): Promise<void> {
    const id = `b-${this.random.uuid()}`;
    try {
      await this.inner.open(url);
      this.sink.write({ kind: "browser-open", id, url, outcome: "complete" });
    } catch (error) {
      this.sink.write({ kind: "browser-open", id, url, outcome: "failed", error: String(error) });
      throw error;
    }
  }
}

export class LoggingCallbackServerFactory extends CallbackServerFactoryPort {
  constructor(
    private readonly inner: CallbackServerFactoryPort,
    private readonly sink: ExchangeSinkPort,
    private readonly clock: ClockPort,
    private readonly random: RandomPort,
  ) {
    super();
  }

  create(): CallbackServerPort {
    return new LoggingCallbackServer(this.inner.create(), this.sink, this.clock, `l-${this.random.uuid()}`);
  }
}

class LoggingCallbackServer extends CallbackServerPort {
  private path = "";
  private port = 0;
  private startedAt = 0;
  private query: CallbackQuery | undefined;
  private receivedAt: number | undefined;

  constructor(
    private readonly inner: CallbackServerPort,
    private readonly sink: ExchangeSinkPort,
    private readonly clock: ClockPort,
    private readonly id: string,
  ) {
    super();
  }

  async start(path: string): Promise<number> {
    this.path = path;
    this.startedAt = this.clock.now();
    this.port = await this.inner.start(path);
    return this.port;
  }

  async waitForCallback(timeoutMs: number): Promise<CallbackQuery> {
    try {
      const query = await this.inner.waitForCallback(timeoutMs);
      this.query = query;
      this.receivedAt = this.clock.now();
      return query;
    } catch (error) {
      this.record({ outcome: "failed", error: String(error) });
      throw error;
    }
  }

  /** The login answers the browser only after a callback arrived (LoginService), so the callback is recorded here. */
  async finish(answer: FinishAnswer): Promise<void> {
    this.record({ outcome: "complete", answer: "redirect" in answer ? `302 ${answer.redirect}` : `${answer.status} ${answer.text}` });
    await this.inner.finish(answer);
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  private record(result: Record<string, unknown>): void {
    const query = this.query;
    this.query = undefined;
    this.sink.write({
      kind: "login-callback",
      id: this.id,
      url: `http://127.0.0.1:${this.port}${this.path}`,
      ...(query !== undefined ? { query } : {}),
      ...result,
      timing: { startedAt: new Date(this.startedAt).toISOString(), ...(this.receivedAt !== undefined ? { callbackMs: this.receivedAt - this.startedAt } : {}), totalMs: this.clock.now() - this.startedAt },
    });
  }
}
