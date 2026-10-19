// P6 (docs/plans/2026-10-17-22-59-p6-live-results-plan.md): what a client sees of one answer, from the network reads
// it made (each with its arrival time). Pure: the event framing of the four formats (SSE, or Gemini's JSON-array
// stream), the answer text, the terminal event, and the statistics of the reads that carried answer text.
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";

/** One network read of the response body: its arrival time (ms since the request was sent) and its text. */
export type BodyRead = { readonly atMs: number; readonly text: string };

/** One complete event of a stream, timed by the read that completed it. */
export type StreamEvent = { readonly read: number; readonly atMs: number; readonly data: unknown };

export type StreamAnalysis = {
  readonly events: number;
  readonly firstEventMs: number | undefined;
  /** The first event carrying answer text (time to first token). */
  readonly firstTokenMs: number | undefined;
  readonly lastEventMs: number | undefined;
  /** The network reads whose events carried answer text. */
  readonly textReads: number;
  readonly textSpanMs: number | undefined;
  readonly medianGapMs: number | undefined;
  readonly maxGapMs: number | undefined;
  readonly terminal: boolean;
  readonly text: string;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Server-sent events: blocks end at a blank line; the `data:` lines of a block are its payload (JSON or `[DONE]`). */
export function sseEvents(reads: readonly BodyRead[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  let buffer = "";
  reads.forEach((read, index) => {
    buffer += read.text.replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      events.push({ read: index, atMs: read.atMs, data: parse(data) });
    }
  });
  return events;
}

const parse = (data: string): unknown => {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
};

/** Gemini's stream without `alt=sse`: one JSON array whose elements arrive one by one. */
export function jsonArrayEvents(reads: readonly BodyRead[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  reads.forEach((read, index) => {
    for (const ch of read.text) {
      if (depth > 0) current += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") {
        if (depth === 0) current = "{";
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) events.push({ read: index, atMs: read.atMs, data: parse(current) });
      }
    }
  });
  return events;
}

/** The answer text an event carries (thinking and tool calls are not answer text). */
export function eventText(format: WireFormat, data: unknown): string {
  if (!isObject(data)) return "";
  switch (format) {
    case "anthropic-messages": {
      const delta = data["delta"];
      return data["type"] === "content_block_delta" && isObject(delta) && delta["type"] === "text_delta" && typeof delta["text"] === "string" ? delta["text"] : "";
    }
    case "openai-chat": {
      const choice = Array.isArray(data["choices"]) ? data["choices"][0] : undefined;
      const delta = isObject(choice) ? choice["delta"] : undefined;
      return isObject(delta) && typeof delta["content"] === "string" ? delta["content"] : "";
    }
    case "openai-responses":
      return data["type"] === "response.output_text.delta" && typeof data["delta"] === "string" ? data["delta"] : "";
    case "gemini":
      return geminiText(data);
  }
}

/** Gemini parts that are text and not thoughts (the Antigravity envelope `{response}` is unwrapped). */
function geminiText(data: Record<string, unknown>): string {
  const body = isObject(data["response"]) ? data["response"] : data;
  const candidates = Array.isArray(body["candidates"]) ? body["candidates"] : [];
  const parts = candidates.flatMap((c) => (isObject(c) && isObject(c["content"]) && Array.isArray(c["content"]["parts"]) ? c["content"]["parts"] : []));
  return parts.map((p) => (isObject(p) && p["thought"] !== true && typeof p["text"] === "string" ? p["text"] : "")).join("");
}

/** The event that ends a complete stream. */
export function isTerminal(format: WireFormat, data: unknown): boolean {
  switch (format) {
    case "anthropic-messages":
      return isObject(data) && data["type"] === "message_stop";
    case "openai-chat":
      return data === "[DONE]";
    case "openai-responses":
      return isObject(data) && data["type"] === "response.completed";
    case "gemini": {
      if (!isObject(data)) return false;
      const body = isObject(data["response"]) ? data["response"] : data;
      return Array.isArray(body["candidates"]) && body["candidates"].some((c) => isObject(c) && typeof c["finishReason"] === "string");
    }
  }
}

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function analyseStream(format: WireFormat, events: readonly StreamEvent[]): StreamAnalysis {
  const texts = events.map((e) => ({ event: e, text: eventText(format, e.data) })).filter((x) => x.text !== "");
  const readTimes = [...new Map(texts.map((x) => [x.event.read, x.event.atMs])).values()];
  const gaps = readTimes.slice(1).map((t, i) => t - readTimes[i]!);
  return {
    events: events.length,
    firstEventMs: events[0]?.atMs,
    firstTokenMs: texts[0]?.event.atMs,
    lastEventMs: events.at(-1)?.atMs,
    textReads: readTimes.length,
    textSpanMs: readTimes.length > 0 ? readTimes.at(-1)! - readTimes[0]! : undefined,
    medianGapMs: median(gaps),
    maxGapMs: gaps.length > 0 ? Math.max(...gaps) : undefined,
    terminal: events.some((e) => isTerminal(format, e.data)),
    text: texts.map((x) => x.text).join(""),
  };
}

/** The answer text of a non-streamed response body. */
export function bodyText(format: WireFormat, body: unknown): string {
  if (!isObject(body)) return "";
  switch (format) {
    case "anthropic-messages":
      return (Array.isArray(body["content"]) ? body["content"] : []).map((b) => (isObject(b) && b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "")).join("");
    case "openai-chat": {
      const choice = Array.isArray(body["choices"]) ? body["choices"][0] : undefined;
      const message = isObject(choice) ? choice["message"] : undefined;
      return isObject(message) && typeof message["content"] === "string" ? message["content"] : "";
    }
    case "openai-responses": {
      const items = Array.isArray(body["output"]) ? body["output"] : [];
      const contents = items.flatMap((i) => (isObject(i) && i["type"] === "message" && Array.isArray(i["content"]) ? i["content"] : []));
      return contents.map((c) => (isObject(c) && c["type"] === "output_text" && typeof c["text"] === "string" ? c["text"] : "")).join("");
    }
    case "gemini":
      return geminiText(body);
  }
}

/** Whether a text is exactly the numbers 1..n separated by whitespace or commas. */
export function isCount(text: string, n: number): boolean {
  const words = text.trim().split(/[\s,]+/);
  return words.length === n && words.every((w, i) => w === String(i + 1));
}
