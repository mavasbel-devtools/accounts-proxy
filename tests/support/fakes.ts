// Test doubles shared by every workspace. Each extends the port it stands in for (no structural fakes).
import { EMPTY_POOL, type AccountPool } from "@inference-router/core/domain/accounts.ts";
import type { JsonValue } from "@inference-router/core/domain/json.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import type { Headers, HttpRequest, HttpResponse } from "@inference-router/core/domain/wire.ts";
import { CredentialStorePort, type PoolChange } from "@inference-router/core/ports/outbound/credentials.ts";
import { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import { ClockPort, LockPort, LoggerPort, RandomPort } from "@inference-router/core/ports/outbound/system.ts";
import { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";

export class FixedClock extends ClockPort {
  constructor(public time = 1_800_000_000_000) {
    super();
  }
  now(): number {
    return this.time;
  }
}

/** uuid() yields uuid-1, uuid-2, …; bytes(n) yields 0,1,2,… (mod 256). */
export class SequenceRandom extends RandomPort {
  private counter = 0;
  uuid(): string {
    this.counter += 1;
    return `uuid-${this.counter}`;
  }
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, i) => i % 256);
  }
}

export class MemoryLogger extends LoggerPort {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`INFO ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`WARN ${message}`);
  }
  error(message: string, cause?: unknown): void {
    this.lines.push(`ERROR ${message}${cause === undefined ? "" : ` ${String(cause)}`}`);
  }
}

/** In-process lock that records acquisitions; `onAcquire` lets a test simulate another process's work. */
export class RecordingLock extends LockPort {
  readonly acquired: string[] = [];
  onAcquire: (() => Promise<void>) | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      this.acquired.push(name);
      if (this.onAcquire) await this.onAcquire();
      return work();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export class MemoryCredentialStore extends CredentialStorePort {
  readonly pools = new Map<ProviderId, AccountPool>();
  /** Writes performed by update (a change returning the same pool writes nothing). */
  saves = 0;
  /** Runs inside update between the read and the change, to simulate another writer racing it. */
  onUpdate: ((provider: ProviderId) => void) | undefined;
  async load(provider: ProviderId): Promise<AccountPool> {
    return this.pools.get(provider) ?? EMPTY_POOL;
  }
  async update(provider: ProviderId, change: PoolChange): Promise<AccountPool> {
    this.onUpdate?.(provider);
    const pool = await this.load(provider);
    const next = change(pool);
    if (next !== pool) {
      this.saves += 1;
      this.pools.set(provider, next);
    }
    return next;
  }
  /** Test setup: store a pool directly (not a port method). */
  seed(provider: ProviderId, pool: AccountPool): void {
    this.pools.set(provider, pool);
  }
}

export class MemoryKeyValueStore extends KeyValueStorePort {
  readonly values = new Map<string, JsonValue>();
  failRead: Error | undefined;
  failWrite: Error | undefined;
  async read(key: string): Promise<JsonValue | undefined> {
    if (this.failRead) throw this.failRead;
    return this.values.get(key);
  }
  async write(key: string, value: JsonValue): Promise<void> {
    if (this.failWrite) throw this.failWrite;
    this.values.set(key, structuredClone(value));
  }
}

export type ScriptedResponse = {
  readonly status: number;
  readonly headers?: Headers;
  /** Whole body, or explicit chunks (each yielded separately), or an async generator for timing tests. */
  readonly body?: string | readonly string[] | (() => AsyncIterable<Uint8Array>);
};

export async function* chunks(parts: readonly string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

export class ScriptedTransport extends HttpTransportPort {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly handler: (request: HttpRequest, index: number) => ScriptedResponse | Promise<ScriptedResponse>) {
    super();
  }
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const scripted = await this.handler(request, this.requests.length - 1);
    const body = scripted.body ?? "";
    return {
      status: scripted.status,
      headers: scripted.headers ?? {},
      body: typeof body === "function" ? body() : chunks(typeof body === "string" ? [body] : body),
    };
  }
}

export async function collect(body: AsyncIterable<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for await (const chunk of body) out.push(decoder.decode(chunk));
  return out;
}
