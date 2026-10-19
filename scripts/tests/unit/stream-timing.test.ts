// P6 stream timing: event framing, answer text, terminal events and read statistics of the four formats.
import { describe, expect, test } from "bun:test";
import { analyseStream, bodyText, eventText, isCount, isTerminal, jsonArrayEvents, sseEvents, type BodyRead } from "@accounts-proxy/scripts/evidence/live/stream-timing.ts";

const sse = (...frames: unknown[]) => frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");

describe("event framing", () => {
  test("SSE: an event belongs to the read that completed it; CRLF, event lines, multi-line data, non-JSON data", () => {
    const reads: BodyRead[] = [
      { atMs: 10, text: 'event: a\r\ndata: {"x":' },
      { atMs: 20, text: "1}\r\n\r\ndata: [DONE]\n\n: comment\n\n" },
      { atMs: 30, text: "data: line1\ndata: line2\n\ndata: {}" },
    ];
    expect(sseEvents(reads)).toEqual([
      { read: 1, atMs: 20, data: { x: 1 } },
      { read: 1, atMs: 20, data: "[DONE]" },
      { read: 2, atMs: 30, data: "line1\nline2" },
    ]);
  });

  test("JSON array: elements split across reads, braces and quotes inside strings", () => {
    const reads: BodyRead[] = [
      { atMs: 5, text: '[{"a":"}{\\"",' },
      { atMs: 9, text: '"b":{"c":1}}\n,{"d":' },
      { atMs: 12, text: "2}]" },
    ];
    expect(jsonArrayEvents(reads)).toEqual([
      { read: 1, atMs: 9, data: { a: '}{"', b: { c: 1 } } },
      { read: 2, atMs: 12, data: { d: 2 } },
    ]);
    expect(jsonArrayEvents([{ atMs: 1, text: "[{bad}]" }])).toEqual([{ read: 0, atMs: 1, data: "{bad}" }]);
  });
});

describe("answer text and terminal events", () => {
  test("Anthropic Messages", () => {
    expect(eventText("anthropic-messages", { type: "content_block_delta", delta: { type: "text_delta", text: "1 " } })).toBe("1 ");
    expect(eventText("anthropic-messages", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } })).toBe("");
    expect(eventText("anthropic-messages", { type: "content_block_delta" })).toBe("");
    expect([isTerminal("anthropic-messages", { type: "message_stop" }), isTerminal("anthropic-messages", "x")]).toEqual([true, false]);
    expect(bodyText("anthropic-messages", { content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "1 2" }] })).toBe("1 2");
    expect(bodyText("anthropic-messages", {})).toBe("");
  });

  test("OpenAI Chat", () => {
    expect(eventText("openai-chat", { choices: [{ delta: { content: "1" } }] })).toBe("1");
    expect(eventText("openai-chat", { choices: [{ delta: { reasoning: "r" } }] })).toBe("");
    expect(eventText("openai-chat", { choices: [] })).toBe("");
    expect(eventText("openai-chat", {})).toBe("");
    expect([isTerminal("openai-chat", "[DONE]"), isTerminal("openai-chat", {})]).toEqual([true, false]);
    expect(bodyText("openai-chat", { choices: [{ message: { content: "1 2" } }] })).toBe("1 2");
    expect(bodyText("openai-chat", { choices: [{}] })).toBe("");
    expect(bodyText("openai-chat", {})).toBe("");
  });

  test("OpenAI Responses", () => {
    expect(eventText("openai-responses", { type: "response.output_text.delta", delta: "1" })).toBe("1");
    expect(eventText("openai-responses", { type: "response.reasoning_text.delta", delta: "r" })).toBe("");
    expect([isTerminal("openai-responses", { type: "response.completed" }), isTerminal("openai-responses", { type: "response.failed" })]).toEqual([true, false]);
    const output = [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "1 2" }, { type: "refusal" }] }];
    expect(bodyText("openai-responses", { output })).toBe("1 2");
    expect(bodyText("openai-responses", {})).toBe("");
  });

  test("Gemini: plain and in the Antigravity envelope; thoughts are not answer text", () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "think", thought: true }, { text: "1 " }, { functionCall: {} }] } }] };
    expect(eventText("gemini", chunk)).toBe("1 ");
    expect(eventText("gemini", { response: chunk })).toBe("1 ");
    expect(eventText("gemini", { candidates: [{}, "x"] })).toBe("");
    expect(eventText("gemini", "x")).toBe("");
    expect(isTerminal("gemini", { candidates: [{ finishReason: "STOP" }] })).toBe(true);
    expect(isTerminal("gemini", { response: { candidates: [{ finishReason: "STOP" }] } })).toBe(true);
    expect([isTerminal("gemini", { candidates: [{}] }), isTerminal("gemini", {}), isTerminal("gemini", "x")]).toEqual([false, false, false]);
    expect(bodyText("gemini", chunk)).toBe("1 ");
    expect(bodyText("gemini", null)).toBe("");
  });
});

describe("analysis", () => {
  test("statistics over the reads that carried text", () => {
    const reads: BodyRead[] = [
      { atMs: 100, text: sse({ type: "message_start" }) },
      { atMs: 150, text: sse({ type: "content_block_delta", delta: { type: "text_delta", text: "1 " } }, { type: "content_block_delta", delta: { type: "text_delta", text: "2 " } }) },
      { atMs: 170, text: sse({ type: "content_block_delta", delta: { type: "text_delta", text: "3 " } }) },
      { atMs: 260, text: sse({ type: "content_block_delta", delta: { type: "text_delta", text: "4" } }, { type: "message_stop" }) },
    ];
    expect(analyseStream("anthropic-messages", sseEvents(reads))).toEqual({
      events: 6,
      firstEventMs: 100,
      firstTokenMs: 150,
      lastEventMs: 260,
      textReads: 3,
      textSpanMs: 110,
      medianGapMs: 55,
      maxGapMs: 90,
      terminal: true,
      text: "1 2 3 4",
    });
  });

  test("an odd number of gaps, one read, and nothing at all", () => {
    const delta = (text: string) => sse({ type: "response.output_text.delta", delta: text });
    const three = analyseStream("openai-responses", sseEvents([{ atMs: 1, text: delta("a") }, { atMs: 3, text: delta("b") }, { atMs: 10, text: delta("c") }, { atMs: 11, text: delta("d") }]));
    expect([three.medianGapMs, three.maxGapMs, three.terminal]).toEqual([2, 7, false]);
    const one = analyseStream("openai-chat", sseEvents([{ atMs: 4, text: sse({ choices: [{ delta: { content: "x" } }] }, "[DONE]") }]));
    expect([one.textReads, one.textSpanMs, one.medianGapMs, one.maxGapMs, one.terminal]).toEqual([1, 0, undefined, undefined, true]);
    expect(analyseStream("gemini", [])).toEqual({ events: 0, firstEventMs: undefined, firstTokenMs: undefined, lastEventMs: undefined, textReads: 0, textSpanMs: undefined, medianGapMs: undefined, maxGapMs: undefined, terminal: false, text: "" });
  });

  test("the count check", () => {
    expect([isCount("1 2 3", 3), isCount(" 1, 2,3\n", 3), isCount("1 2 4", 3), isCount("1 2", 3)]).toEqual([true, true, false, false]);
  });
});
