// The exchange log (plan 2026-10-26 X1–X4): one JSON record per side of every HTTP exchange — the client's request to
// the daemon and its answer, every request the proxy sends upstream and its answer, the login's loopback callback and
// the page it opens. Bodies are recorded whole with each chunk's arrival time and size; the token usage an answer
// states is read from its own fields in every format; credential values are replaced by a fingerprint before a record
// is written, everything else is kept.

export const EXCHANGE_LOG_SCHEMA = "accounts-proxy-exchange/1";

export type ExchangeKind = "client-request" | "client-response" | "upstream-request" | "upstream-response" | "login-callback" | "browser-open";

/** A recorded body: UTF-8 text, or base64 when the bytes are not valid UTF-8. */
export type RecordedBody = {
  readonly encoding: "utf8" | "base64";
  readonly text: string;
  readonly bytes: number;
};

/** One response chunk: milliseconds after the exchange started, and its size in bytes. */
export type RecordedChunk = { readonly t: number; readonly bytes: number };

/** The normalized counts (each only when the answer states the field it maps from, never computed). */
export type TokenCounts = {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly toolUsePrompt?: number;
  readonly total?: number;
};

export type TokenUsage = { readonly raw: Readonly<Record<string, unknown>>; readonly tokens: TokenCounts };

/** One side of an exchange, as the recording code produces it. */
export type ExchangeEntry = {
  readonly kind: ExchangeKind;
  /** Shared by the request and the response record of one exchange. */
  readonly id: string;
  /** The client exchange an upstream call was made for (absent: a command's own call, or no client exchange). */
  readonly exchange?: string;
  readonly [field: string]: unknown;
};

/** An entry as written: with the schema, the ISO time it was written and the writing process. */
export type ExchangeRecord = ExchangeEntry & { readonly schema: typeof EXCHANGE_LOG_SCHEMA; readonly at: string; readonly pid: number };

/** Header pairs in the order (and, for the client's, the case) they were sent. */
export type RecordedHeaders = readonly (readonly [string, string])[];

/**
 * Accumulates a streamed body: every chunk's size and time, and the text (decoded with a streaming UTF-8 decoder, so
 * a character split across chunks is kept); when the bytes are not valid UTF-8 the whole body is kept as base64.
 */
export class BodyRecorder {
  private readonly parts: Uint8Array[] = [];
  private readonly timed: RecordedChunk[] = [];
  private size = 0;

  constructor(private readonly startedAt: number) {}

  add(chunk: Uint8Array, at: number): void {
    this.parts.push(chunk);
    this.size += chunk.length;
    this.timed.push({ t: at - this.startedAt, bytes: chunk.length });
  }

  get chunks(): readonly RecordedChunk[] {
    return this.timed;
  }

  get firstByteAfterMs(): number | undefined {
    return this.timed[0]?.t;
  }

  body(): RecordedBody {
    return recordBytes(concat(this.parts, this.size));
  }
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A body given as text or bytes. */
export function recordBody(body: string | Uint8Array | undefined): RecordedBody {
  if (body === undefined) return { encoding: "utf8", text: "", bytes: 0 };
  if (typeof body === "string") return { encoding: "utf8", text: body, bytes: new TextEncoder().encode(body).length };
  return recordBytes(body);
}

function recordBytes(bytes: Uint8Array): RecordedBody {
  try {
    return { encoding: "utf8", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: bytes.length };
  } catch {
    return { encoding: "base64", text: base64(bytes), bytes: bytes.length };
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Header pairs as sent: the pairs themselves, or a record's entries (insertion order). */
export function headerPairs(headers: Readonly<Record<string, string>> | RecordedHeaders): RecordedHeaders {
  return Array.isArray(headers) ? (headers as RecordedHeaders).map(([k, v]) => [k, v] as const) : Object.entries(headers);
}

// ---------------------------------------------------------------------------------------------------------------
// Token usage (X3). The fields each format states, per its reference:
//   Anthropic Messages `usage` (message_start / message_delta when streamed): input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens, cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens.
//   OpenAI Chat Completions `usage`: prompt_tokens, completion_tokens, total_tokens,
//     prompt_tokens_details.{cached_tokens, cache_write_tokens (OpenRouter)}, completion_tokens_details.reasoning_tokens.
//   OpenAI Responses `usage` (response.completed when streamed): input_tokens, output_tokens, total_tokens,
//     input_tokens_details.cached_tokens, output_tokens_details.reasoning_tokens.
//   Gemini / Antigravity `usageMetadata`: promptTokenCount, candidatesTokenCount, totalTokenCount,
//     cachedContentTokenCount, thoughtsTokenCount, toolUsePromptTokenCount.
// The raw fields are kept verbatim: Anthropic's input_tokens excludes cached input while OpenAI's prompt_tokens and
// Gemini's promptTokenCount include it, so `tokens` maps each stated field without adding or subtracting.

const USAGE_KEYS = new Set(["usage", "usageMetadata"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The usage stated in a JSON or server-sent-events body (every `data:` line), merged in arrival order. */
export function tokenUsage(text: string): TokenUsage | undefined {
  const raw: Json = {};
  let found = false;
  for (const value of jsonValues(text)) {
    for (const usage of usageObjects(value)) {
      // A later usage object restates the earlier counts (Anthropic's message_delta, Gemini's last chunk): it wins.
      Object.assign(raw, usage);
      found = true;
    }
  }
  return found ? { raw, tokens: normalize(raw) } : undefined;
}

function jsonValues(text: string): unknown[] {
  const whole = parse(text);
  if (whole !== undefined) return [whole];
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = parse(line.slice(5).trim());
    if (value !== undefined) values.push(value);
  }
  // A body of JSON array elements streamed one per line (Gemini's non-SSE stream) also parses whole; nothing else.
  return values;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function usageObjects(value: unknown): Json[] {
  const out: Json[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (USAGE_KEYS.has(key) && isObject(child)) out.push(child);
      else walk(child);
    }
  };
  walk(value);
  return out;
}

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const at = (raw: Json, path: readonly string[]): number | undefined => {
  let node: unknown = raw;
  for (const key of path) node = isObject(node) ? node[key] : undefined;
  return num(node);
};

const MAPPING: readonly (readonly [keyof TokenCounts, readonly (readonly string[])[]])[] = [
  ["input", [["input_tokens"], ["prompt_tokens"], ["promptTokenCount"]]],
  ["output", [["output_tokens"], ["completion_tokens"], ["candidatesTokenCount"]]],
  ["cacheRead", [["cache_read_input_tokens"], ["prompt_tokens_details", "cached_tokens"], ["input_tokens_details", "cached_tokens"], ["cachedContentTokenCount"]]],
  ["cacheWrite", [["cache_creation_input_tokens"], ["prompt_tokens_details", "cache_write_tokens"]]],
  ["cacheWrite5m", [["cache_creation", "ephemeral_5m_input_tokens"]]],
  ["cacheWrite1h", [["cache_creation", "ephemeral_1h_input_tokens"]]],
  ["reasoning", [["completion_tokens_details", "reasoning_tokens"], ["output_tokens_details", "reasoning_tokens"], ["thoughtsTokenCount"]]],
  ["toolUsePrompt", [["toolUsePromptTokenCount"]]],
  ["total", [["total_tokens"], ["totalTokenCount"]]],
];

function normalize(raw: Json): TokenCounts {
  const tokens: Partial<Record<keyof TokenCounts, number>> = {};
  for (const [name, paths] of MAPPING) {
    for (const path of paths) {
      const value = at(raw, path);
      if (value !== undefined) {
        tokens[name] = value;
        break;
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction (X4).

export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "cookie", "set-cookie"]);
/** Top-level fields of a request body or query that carry a credential (OAuth grants, device logins, keys). */
export const REQUEST_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "code_verifier",
  "client_secret",
  "device_code",
  "key",
  "api_key",
  "token",
  "password",
  "sig",
]);
/** Top-level fields of an answer that carry a credential (token, key and device answers). */
export const RESPONSE_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(["access_token", "refresh_token", "id_token", "client_secret", "device_code", "key", "api_key", "token"]);
/** Known credential prefixes (the recon redaction manifest's `tokenPrefixes`; a unit test keeps them equal). */
export const TOKEN_PREFIXES: readonly string[] = ["sk-ant-", "ya29.", "1//", "eyJhbGci", "sk-or-", "oc_sk_", "ci_live_", "ir_live_"];
/** The shortest tail after a prefix that is treated as a credential (the manifest's `tokenBodyMinTail`). */
export const TOKEN_MIN_TAIL = 8;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PREFIXED = new RegExp(`(?:${TOKEN_PREFIXES.map(escape).join("|")})[A-Za-z0-9._~+/=-]{${TOKEN_MIN_TAIL},}`, "g");

/** Replaces credential values; `fingerprint` names a value without revealing it (same value, same mark). */
export class Redactor {
  constructor(private readonly fingerprint: (value: string) => string) {}

  mark(value: string): string {
    return `[redacted sha256:${this.fingerprint(value)} len:${value.length}]`;
  }

  /** Every substring with a known credential prefix. */
  text(text: string): string {
    return text.replace(PREFIXED, (match) => this.mark(match));
  }

  headers(headers: RecordedHeaders): RecordedHeaders {
    return headers.map(([name, value]) => [name, CREDENTIAL_HEADERS.has(name.toLowerCase()) ? this.mark(value) : this.text(value)] as const);
  }

  query(query: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, REQUEST_CREDENTIAL_FIELDS.has(k) ? this.mark(v) : this.text(v)]));
  }

  /** A URL's credential query parameters, and every prefixed credential in it. */
  url(url: string): string {
    const question = url.indexOf("?");
    if (question < 0) return this.text(url);
    // Only `name=value` pairs carry a value; a bare `flag` is left as it is.
    const params = url
      .slice(question + 1)
      .replace(/(^|&)([^=&]+)=([^&]*)/g, (pair, separator: string, name: string, value: string) =>
        REQUEST_CREDENTIAL_FIELDS.has(decode(name)) ? `${separator}${name}=${encodeURIComponent(this.mark(decode(value)))}` : pair,
      );
    return this.text(`${url.slice(0, question)}?${params}`);
  }

  /** A whole body: its top-level credential fields (JSON object or form) and every prefixed credential. */
  body(body: RecordedBody, fields: ReadonlySet<string>): RecordedBody {
    if (body.encoding === "base64") return body;
    return { ...body, text: this.bodyText(body.text, fields) };
  }

  /** A body's text: its top-level credential fields (JSON object or form) and every prefixed credential. */
  bodyText(text: string, fields: ReadonlySet<string>): string {
    const json = parse(text);
    if (isObject(json)) {
      let changed = false;
      const out: Json = {};
      for (const [key, value] of Object.entries(json)) {
        if (fields.has(key) && typeof value === "string") {
          out[key] = this.mark(value);
          changed = true;
        } else out[key] = value;
      }
      return this.text(changed ? JSON.stringify(out) : text);
    }
    if (json === undefined && /^[\w.~%+-]+=[^\s]*(&[\w.~%+-]+=[^\s]*)*$/.test(text)) {
      return this.text(
        text
          .split("&")
          .map((pair) => {
            const eq = pair.indexOf("=");
            const name = decode(pair.slice(0, eq));
            return fields.has(name) ? `${pair.slice(0, eq)}=${encodeURIComponent(this.mark(decode(pair.slice(eq + 1))))}` : pair;
          })
          .join("&"),
      );
    }
    return this.text(text);
  }
}

/** Form decoding (`+` is a space); a malformed escape becomes U+FFFD instead of failing (URLSearchParams). */
function decode(text: string): string {
  return new URLSearchParams(`v=${text}`).get("v")!;
}

const REQUEST_KINDS: ReadonlySet<ExchangeKind> = new Set(["client-request", "upstream-request", "login-callback", "browser-open"]);

/** A record with every credential value replaced (the one step before a record is written). */
export function redactEntry(record: ExchangeEntry, redactor: Redactor): ExchangeEntry {
  const fields = REQUEST_KINDS.has(record.kind) ? REQUEST_CREDENTIAL_FIELDS : RESPONSE_CREDENTIAL_FIELDS;
  const out: Record<string, unknown> = { ...record };
  if (typeof record["url"] === "string") out["url"] = redactor.url(record["url"]);
  if (typeof record["path"] === "string") out["path"] = redactor.text(record["path"]);
  if (isObject(record["query"])) out["query"] = redactor.query(record["query"] as Record<string, string>);
  if (Array.isArray(record["headers"])) out["headers"] = redactor.headers(record["headers"] as RecordedHeaders);
  if (isObject(record["body"])) out["body"] = redactor.body(record["body"] as RecordedBody, fields);
  if (typeof record["decodedBody"] === "string") out["decodedBody"] = redactor.bodyText(record["decodedBody"], fields);
  if (typeof record["error"] === "string") out["error"] = redactor.text(record["error"]);
  if (typeof record["answer"] === "string") out["answer"] = redactor.text(record["answer"]);
  return out as ExchangeEntry;
}
