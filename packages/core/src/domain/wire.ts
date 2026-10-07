// Transport-neutral HTTP message shapes used by ports (bodies are bytes; streaming bodies are async iterables).

export type Headers = Readonly<Record<string, string>>;

export type HttpRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Headers;
  readonly body?: string;
  /** Abort the request (including the body read) after this many milliseconds. */
  readonly timeoutMs?: number;
};

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
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
};
