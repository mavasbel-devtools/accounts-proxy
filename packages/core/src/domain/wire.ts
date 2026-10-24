// Transport-neutral HTTP message shapes used by ports (bodies are bytes; streaming bodies are async iterables).
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";

export type HeaderPairs = readonly (readonly [string, string])[] & Readonly<Record<string, string>>;
export type Headers = Readonly<Record<string, string>>;

export function orderedHeaders(pairs: readonly (readonly [string, string])[]): HeaderPairs {
  const result = [...pairs] as unknown as (readonly [string, string])[] & Record<string, string>;
  for (const [k, v] of pairs) {
    result[k.toLowerCase()] = v;
  }
  return result as unknown as HeaderPairs;
}

export type HttpRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Headers | HeaderPairs;
  /** Text, or bytes already encoded for the request's `content-encoding`. */
  readonly body?: string | Uint8Array;
  /** Abort the request (including the body read) after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Aborts the exchange, body read included (the client of a streamed response disconnected). */
  readonly signal?: AbortSignal | undefined;
};

/** 10 minutes: the captured Claude Code client sends `x-stainless-timeout: 600`; streams idle longer than this fail. */
export const UPSTREAM_IDLE_TIMEOUT_MS = 600_000;

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<Uint8Array>;
};

/** Drain a streaming body into one UTF-8 string (for small responses: token endpoints, catalogs, errors). */
export async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** A one-shot body, e.g. for a locally generated response. */
export async function* bodyOf(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** A client request received on a native route, forwarded without canonical translation. */
export type RawRequest = {
  /** The route's request format (plan P4.6 §2). */
  readonly format: WireFormat;
  /** Path relative to the dialect prefix, e.g. `/v1/messages` or `/v1beta/models/<model>:streamGenerateContent`. */
  readonly path: string;
  /** Query parameters (the proxy token's `key` already removed). */
  readonly query: Readonly<Record<string, string>>;
  /** Client headers, names lower-cased. */
  readonly headers: Headers;
  readonly body: string;
  /** `x-proxy-lossy: 1`: features the target cannot carry are dropped and reported instead of rejected. */
  readonly lossy: boolean;
  /** Aborted when the client disconnects. */
  readonly signal?: AbortSignal | undefined;
};

/** Response header naming every feature or element removed from the request (AGENTS.md §4). */
export const DROPPED_HEADER = "x-proxy-dropped";
