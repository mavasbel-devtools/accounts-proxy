import { describe, expect, test } from "bun:test";
import { EventStreamCodec, SseCodec } from "../../src/domain/services/event-stream.ts";

describe("SseCodec (WHATWG server-sent events)", () => {
  test("is an EventStreamCodec", () => {
    expect(new SseCodec()).toBeInstanceOf(EventStreamCodec);
  });

  test("dispatches on blank lines, joins multi-line data, handles event names", () => {
    const codec = new SseCodec();
    expect(codec.push("event: message_start\ndata: {\"a\":1}\n\ndata: x\ndata: y\n\n")).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { data: "x\ny" },
    ]);
  });

  test("accepts CRLF and CR line endings, including CRLF split across chunks", () => {
    const codec = new SseCodec();
    expect(codec.push("data: a\r")).toEqual([]);
    // the trailing lone CR could still be the first half of a CRLF, so frame "b" waits for the next chunk
    expect(codec.push("\n\r\ndata: b\r\r")).toEqual([{ data: "a" }]);
    expect(codec.push("data: c\n\n")).toEqual([{ data: "b" }, { data: "c" }]);
  });

  test("frames split at arbitrary byte boundaries", () => {
    const codec = new SseCodec();
    const text = "event: e\ndata: hello\n\n";
    const frames = [...text].flatMap((ch) => codec.push(ch));
    expect(frames).toEqual([{ event: "e", data: "hello" }]);
  });

  test("ignores comments and unknown fields; strips exactly one leading space; field without colon", () => {
    const codec = new SseCodec();
    expect(codec.push(": keepalive\nid: 7\nretry: 10\ndata:  two\ndata\ndata:nospace\n\n")).toEqual([{ data: " two\n\nnospace" }]);
  });

  test("a frame without data is not dispatched and resets the event name", () => {
    const codec = new SseCodec();
    expect(codec.push("event: ping\n\ndata: z\n\n")).toEqual([{ data: "z" }]);
  });

  test("an empty data field dispatches an empty string", () => {
    expect(new SseCodec().push("data:\n\n")).toEqual([{ data: "" }]);
  });

  test("end() discards an unterminated frame and reports it", () => {
    const pendingData = new SseCodec();
    pendingData.push("data: half\n");
    expect(pendingData.end()).toEqual({ discarded: true });
    const pendingLine = new SseCodec();
    pendingLine.push("data: no newline");
    expect(pendingLine.end()).toEqual({ discarded: true });
    const pendingEvent = new SseCodec();
    pendingEvent.push("event: x\n");
    expect(pendingEvent.end()).toEqual({ discarded: true });
    const clean = new SseCodec();
    clean.push("data: done\n\n");
    expect(clean.end()).toEqual({ discarded: false });
    expect(clean.push("data: after\n\n")).toEqual([{ data: "after" }]);
  });

  test("encode round-trips through push, including multi-line data", () => {
    const codec = new SseCodec();
    const encoded = codec.encode({ event: "content_block_delta", data: "line1\nline2" }) + codec.encode({ data: "[DONE]" });
    expect(encoded).toBe("event: content_block_delta\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n");
    expect(new SseCodec().push(encoded)).toEqual([{ event: "content_block_delta", data: "line1\nline2" }, { data: "[DONE]" }]);
  });
});
