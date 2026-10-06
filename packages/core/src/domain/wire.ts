// Transport-neutral HTTP message shapes used by ports (bodies are bytes; streaming bodies are async iterables).

export type Headers = Readonly<Record<string, string>>;

export type HttpRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Headers;
  readonly body?: string;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<Uint8Array>;
};

/** A client request received on a native route, forwarded without canonical translation. */
export type RawRequest = {
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
};
