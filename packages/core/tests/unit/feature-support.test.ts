import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import { UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { DROPPABLE, drop, featuresOf, negotiate, type Feature } from "@inference-router/core/domain/services/feature-support.ts";

const base: CanonicalRequest = {
  model: { provider: "antigravity", model: "gemini-3-pro" },
  system: [],
  messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
  tools: [],
  params: {},
  stream: true,
};

const rich: CanonicalRequest = {
  ...base,
  system: [{ kind: "text", text: "sys" }],
  messages: [
    {
      role: "user",
      parts: [
        { kind: "text", text: "look" },
        { kind: "image", source: { type: "base64", mediaType: "image/png", data: "AA" } },
        { kind: "document", source: { type: "url", url: "https://x/y.pdf" }, title: "y" },
      ],
    },
    {
      role: "assistant",
      parts: [
        { kind: "thinking", text: "hmm", signature: "sig-claude", origin: "claude" },
        { kind: "thinking", text: "own", signature: "sig-own", origin: "antigravity" },
        { kind: "tool_call", id: "c1", name: "shot", input: {} },
      ],
    },
    {
      role: "user",
      parts: [
        {
          kind: "tool_result",
          callId: "c1",
          isError: false,
          content: [
            { kind: "text", text: "ok" },
            { kind: "image", source: { type: "base64", mediaType: "image/png", data: "BB" } },
          ],
        },
      ],
    },
    { role: "user", parts: [{ kind: "image", source: { type: "url", url: "https://x/z.png" } }] },
  ],
  tools: [{ name: "shot", parameters: { type: "object" } }],
  toolChoice: { mode: "required" },
  parallelToolCalls: false,
  params: { maxOutputTokens: 10, temperature: 0.2, topP: 0.9, topK: 40, stopSequences: ["END"] },
  thinking: { mode: "budget", budgetTokens: 1024 },
};

describe("featuresOf", () => {
  test("a plain text request uses nothing optional", () => {
    expect([...featuresOf(base)]).toEqual([]);
  });

  test("detects every feature of a rich request", () => {
    expect([...featuresOf(rich)].sort()).toEqual(
      (<Feature[]>[
        "documents",
        "foreign_thinking_signatures",
        "images",
        "parallel_tool_calls_disabled",
        "stop_sequences",
        "system",
        "temperature",
        "thinking",
        "tool_choice_required",
        "tools",
        "top_k",
        "top_p",
      ]).sort(),
    );
  });

  test("tool choice modes, empty stop list, thinking off, image only inside a tool result, unsigned thinking", () => {
    const none = featuresOf({ ...base, toolChoice: { mode: "none" } });
    expect(none.has("tool_choice_none")).toBe(true);
    expect(featuresOf({ ...base, toolChoice: { mode: "tool", name: "x" } }).has("tool_choice_named")).toBe(true);
    expect(featuresOf({ ...base, toolChoice: { mode: "auto" } }).size).toBe(0);
    expect(featuresOf({ ...base, params: { stopSequences: [] } }).size).toBe(0);
    expect(featuresOf({ ...base, thinking: { mode: "off" } }).size).toBe(0);
    const nested = featuresOf({
      ...base,
      messages: [
        {
          role: "user",
          parts: [{ kind: "tool_result", callId: "c", isError: false, content: [{ kind: "image", source: { type: "url", url: "u" } }] }],
        },
      ],
    });
    expect([...nested].sort()).toEqual(["images", "tools"]);
    const unsigned = featuresOf({ ...base, messages: [{ role: "assistant", parts: [{ kind: "thinking", text: "t" }] }] });
    expect(unsigned.has("foreign_thinking_signatures")).toBe(false);
  });
});

describe("negotiate", () => {
  const all = new Set<Feature>([...featuresOf(rich)]);

  test("passes through untouched when everything is supported", () => {
    const result = negotiate(rich, all, { lossy: false }, "antigravity");
    expect(result.request).toBe(rich);
    expect(result.dropped).toEqual([]);
  });

  test("strict: any missing feature is a 400 naming every missing feature (sorted)", () => {
    const supported = new Set<Feature>([...all].filter((f) => f !== "top_k" && f !== "images"));
    try {
      negotiate(rich, supported, { lossy: false }, "antigravity");
      throw new Error("expected UnsupportedFeatureError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedFeatureError);
      expect((error as UnsupportedFeatureError).features).toEqual(["images", "top_k"]);
    }
  });

  test("lossy: non-droppable features still fail", () => {
    const supported = new Set<Feature>([...all].filter((f) => f !== "tool_choice_required" && f !== "top_k"));
    expect(() => negotiate(rich, supported, { lossy: true }, "x")).toThrow(/tool_choice_required/);
  });

  test("lossy: droppable features are removed and reported", () => {
    const supported = new Set<Feature>([...all].filter((f) => !DROPPABLE.has(f)));
    const { request, dropped } = negotiate(rich, supported, { lossy: true }, "antigravity");
    expect(dropped).toEqual(
      (<Feature[]>[
        "documents",
        "foreign_thinking_signatures",
        "images",
        "parallel_tool_calls_disabled",
        "stop_sequences",
        "temperature",
        "thinking",
        "top_k",
        "top_p",
      ]).sort(),
    );
    expect([...featuresOf(request)].sort()).toEqual(["system", "tool_choice_required", "tools"]);
    expect(request.params).toEqual({ maxOutputTokens: 10 });
    expect(request.thinking).toBeUndefined();
    expect(request.parallelToolCalls).toBeUndefined();
    // the image-only user message disappears; the tool result keeps its text but loses its image
    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]!.parts[0]).toEqual({ kind: "tool_result", callId: "c1", isError: false, content: [{ kind: "text", text: "ok" }] });
    // the provider's own signed thinking is kept; the foreign one is removed
    expect(request.messages[1]!.parts.map((p) => p.kind === "thinking" && p.signature)).toEqual(["sig-own", false]);
  });
});

describe("drop", () => {
  test("each parameter drop removes exactly its own key", () => {
    expect(drop(rich, "temperature").params).toEqual({ maxOutputTokens: 10, topP: 0.9, topK: 40, stopSequences: ["END"] });
    expect(drop(rich, "top_p").params).toEqual({ maxOutputTokens: 10, temperature: 0.2, topK: 40, stopSequences: ["END"] });
    expect(drop(rich, "top_k").params).toEqual({ maxOutputTokens: 10, temperature: 0.2, topP: 0.9, stopSequences: ["END"] });
    expect(drop(rich, "stop_sequences").params).toEqual({ maxOutputTokens: 10, temperature: 0.2, topP: 0.9, topK: 40 });
    expect(drop(base, "temperature").params).toEqual({});
  });

  test("refuses a non-droppable feature", () => {
    expect(() => drop(rich, "tools")).toThrow("feature tools is not droppable");
  });
});
