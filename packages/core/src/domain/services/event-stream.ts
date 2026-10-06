// Server-sent events framing (WHATWG HTML §9.2 "Server-sent events", the format every dialect and both
// upstreams use). EventStreamCodec is the general abstraction; SseCodec is the only framing in use.

export type StreamFrame = { readonly event?: string; readonly data: string };

export abstract class EventStreamCodec {
  /** Feed decoded text; returns every frame completed by this chunk. */
  abstract push(chunk: string): StreamFrame[];
  /**
   * End of stream. Per WHATWG ("once the end of the file is reached, any pending data must be discarded") an
   * unterminated frame is NOT dispatched; `discarded` reports whether one was pending so callers can surface a
   * truncated upstream instead of silently losing it.
   */
  abstract end(): { readonly discarded: boolean };
  abstract encode(frame: StreamFrame): string;
}

export class SseCodec extends EventStreamCodec {
  private buffer = "";
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): StreamFrame[] {
    this.buffer += chunk;
    const frames: StreamFrame[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      // A lone trailing CR may be the first half of CRLF: wait for the next chunk.
      if (!match || (match[0] === "\r" && match.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  end(): { readonly discarded: boolean } {
    const discarded = this.buffer !== "" || this.data.length > 0 || this.event !== undefined;
    this.buffer = "";
    this.event = undefined;
    this.data = [];
    return { discarded };
  }

  encode(frame: StreamFrame): string {
    const head = frame.event === undefined ? "" : `event: ${frame.event}\n`;
    return `${head}${frame.data.split(/\r\n|\r|\n/).map((l) => `data: ${l}`).join("\n")}\n\n`;
  }

  private line(line: string): StreamFrame | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }

  private dispatch(): StreamFrame | undefined {
    const event = this.event;
    const hasData = this.data.length > 0;
    const data = this.data.join("\n");
    this.event = undefined;
    this.data = [];
    if (!hasData) return undefined;
    return event === undefined ? { data } : { event, data };
  }
}
