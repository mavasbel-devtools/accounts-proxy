// Outbound ports of the exchange log (plan 2026-10-26 X1–X6).
import type { ExchangeEntry } from "@accounts-proxy/core/domain/exchange-log.ts";

/** Where entries go. Best-effort: a write never throws into the caller (X6). */
export abstract class ExchangeSinkPort {
  abstract write(entry: ExchangeEntry): void;
}

/** The client exchange the current work belongs to, so an upstream call names the request it was made for. */
export abstract class ExchangeScopePort {
  abstract run<T>(exchange: string, work: () => Promise<T>): Promise<T>;
  abstract current(): string | undefined;
}
