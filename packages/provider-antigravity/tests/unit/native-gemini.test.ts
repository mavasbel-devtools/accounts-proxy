// The near-native Gemini cell's pure rules (P4 plan §2.3, decisions Q2–Q4, amendment B1).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidRequestError, UnsupportedFeatureError } from "@accounts-proxy/core/domain/errors.ts";
import type { ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import {
  aggregateResponses,
  foreignSchemaKeywords,
  geminiMethod,
  innerRequest,
  prepareGeminiRequest,
  signedCalls,
  turnView,
  type GeminiResponse,
} from "@accounts-proxy/provider-antigravity/domain/native-gemini.ts";
import type { TrajectorySnapshot } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";

const descriptor = (over: Partial<ModelDescriptor>): ModelDescriptor => ({
  wireId: "gemini-3.6-flash-low",
  displayName: "G",
  maxTokens: 1_048_576,
  maxOutputTokens: 65_536,
  supportsImages: true,
  supportsThinking: true,
  supportsVideo: false,
  recommended: true,
  enumPlaceholder: "MODEL_PLACEHOLDER_M73",
  ...over,
});
const GEMINI = descriptor({ thinkingBudget: 1000 });
const CLAUDE = descriptor({ wireId: "claude-sonnet-5-5-low", maxOutputTokens: 128_000, supportsThinking: false });
const NO_LIMIT = descriptor({ wireId: "chat_20706", maxOutputTokens: 0, supportsThinking: false });

const strict = { lossy: false, signatures: {} };
const lossy = { lossy: true, signatures: {} };
const user = (text: string) => ({ role: "user", parts: [{ text }] });
const hello = { contents: [user("hi")] };

function unsupported(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    return (error as UnsupportedFeatureError).features;
  }
  throw new Error("expected unsupported_feature");
}

describe("geminiMethod", () => {
  test.each([
    ["/v1beta/models/antigravity/g:generateContent", "generateContent"],
    ["/v1beta/models/g:streamGenerateContent", "streamGenerateContent"],
    ["/v1beta/models/g:countTokens", "countTokens"],
    ["/v1beta/models/g:embedContent", undefined],
    ["/v1beta/models/g", undefined],
  ])("%p → %p", (path, method) => {
    expect(geminiMethod(path)).toBe(method as never);
  });
});

describe("foreignSchemaKeywords", () => {
  test("whitelist keywords only; properties keys are names; arrays and nesting walked", () => {
    const schema = {
      type: "object",
      $schema: "x",
      properties: { additionalProperties: { type: "string", minLength: 1 }, list: { type: "array", items: [{ type: "string", pattern: "a" }] } },
      required: ["a"],
    };
    expect([...foreignSchemaKeywords(schema)].sort()).toEqual(["$schema", "minLength", "pattern"]);
    expect([...foreignSchemaKeywords({ properties: "odd" })]).toEqual([]);
    expect([...foreignSchemaKeywords("leaf")]).toEqual([]);
  });
});

describe("prepareGeminiRequest: shape and carried fields", () => {
  test("defaults: maxOutputTokens and the catalog-exact thinking budget are injected", () => {
    const p = prepareGeminiRequest(hello, GEMINI, strict);
    expect(p.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(p.generationConfig).toEqual({ maxOutputTokens: 65_536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } });
    expect(p.dropped).toEqual([]);
    expect(p.turns).toEqual([{ role: "user", text: "hi" }]);
    expect("systemInstruction" in p || "tools" in p || "toolConfig" in p).toBe(false);
  });

  test("body, contents and parts must be well formed", () => {
    for (const [body, message] of [
      [[1], "JSON object"],
      [{}, "contents must be an array"],
      [{ contents: [1] }, "contents[0] must be an object"],
      [{ contents: [{ role: "system", parts: [] }] }, 'role must be "user" or "model"'],
      [{ contents: [{ role: "user" }] }, "parts must be an array"],
      [{ contents: [{ parts: [1] }] }, "parts[0] must be an object"],
      [{ contents: [{ parts: [{ text: 1 }] }] }, "text must be a string"],
      [{ contents: [{ parts: [{ inlineData: "x" }] }] }, "inlineData needs"],
      [{ contents: [{ parts: [{ inlineData: { mimeType: "image/png" } }] }] }, "inlineData needs"],
      [{ contents: [{ parts: [{ inlineData: { data: "AA" } }] }] }, "inlineData needs"],
      [{ contents: [{ parts: [{ fileData: "x" }] }] }, "fileData needs a string fileUri"],
      [{ contents: [{ parts: [{ fileData: { mimeType: "application/pdf" } }] }] }, "fileData needs a string fileUri"],
      [{ contents: [{ parts: [{ fileData: { fileUri: "https://x/a.pdf", mimeType: 1 } }] }] }, "fileData needs a string fileUri"],
      [{ contents: [{ parts: [{ functionCall: {} }] }] }, "functionCall needs a string name"],
      [{ contents: [{ parts: [{ functionResponse: 1 }] }] }, "functionResponse needs a string name"],
      [{ contents: [] }, "no turn left"],
      [{ contents: [{ parts: [] }, { role: "model", parts: [{ text: "only model" }] }] }, "no turn left"],
    ] as const) {
      expect(() => prepareGeminiRequest(body, GEMINI, strict)).toThrow(message);
      expect(() => prepareGeminiRequest(body, GEMINI, strict)).toThrow(InvalidRequestError);
    }
  });

  test("an absent role is user; inline data, thought parts and signatures are carried unchanged", () => {
    const parts = [{ inlineData: { mimeType: "image/png", data: "AA" } }, { text: "what?", thought: false, thoughtSignature: "S" }];
    expect(prepareGeminiRequest({ contents: [{ parts }] }, GEMINI, strict).contents).toEqual([{ role: "user", parts }]);
  });

  test("file data (live media probe M1): fileUri and mimeType are carried, a file-only turn is content, other keys are unsupported", () => {
    const parts = [{ fileData: { fileUri: "https://example.com/a.pdf", mimeType: "application/pdf" } }];
    expect(prepareGeminiRequest({ contents: [{ parts }] }, GEMINI, strict).contents).toEqual([{ role: "user", parts }]);
    const named = { contents: [{ parts: [{ fileData: { fileUri: "https://example.com/a.pdf", displayName: "a.pdf" } }] }] };
    expect(unsupported(() => prepareGeminiRequest(named, GEMINI, strict))).toEqual(["contents.parts.fileData.displayName"]);
    const p = prepareGeminiRequest(named, GEMINI, lossy);
    expect(p.contents[0]!.parts).toEqual([{ fileData: { fileUri: "https://example.com/a.pdf" } }]);
    expect(p.dropped).toEqual(["contents.parts.fileData.displayName"]);
  });

  test("unknown fields anywhere are unsupported (collected, deduplicated); lossy drops and reports them", () => {
    const body = {
      ...hello,
      safetySettings: [],
      cachedContent: "c",
      contents: [{ role: "user", parts: [{ text: "a", videoMetadata: {} }, { text: "b", videoMetadata: {} }] }],
      generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } },
    };
    expect(unsupported(() => prepareGeminiRequest(body, GEMINI, strict))).toEqual([
      "safetySettings",
      "cachedContent",
      "contents.parts.videoMetadata",
      "generationConfig.responseMimeType",
      "generationConfig.thinkingConfig.thinkingLevel",
    ]);
    const p = prepareGeminiRequest(body, GEMINI, lossy);
    expect(p.contents[0]!.parts).toEqual([{ text: "a" }, { text: "b" }]);
    expect(p.generationConfig).toEqual({ maxOutputTokens: 65_536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } });
    expect(p.dropped).toEqual(["safetySettings", "cachedContent", "contents.parts.videoMetadata", "generationConfig.responseMimeType", "generationConfig.thinkingConfig.thinkingLevel"]);
  });
});

describe("prepareGeminiRequest: generationConfig", () => {
  test("media settings (live media probe M1): TEXT/IMAGE output and the probed resolutions are carried; other values are unsupported", () => {
    const config = { responseModalities: ["TEXT", "IMAGE"], mediaResolution: "MEDIA_RESOLUTION_HIGH" };
    expect(prepareGeminiRequest({ ...hello, generationConfig: config }, GEMINI, strict).generationConfig).toEqual({
      maxOutputTokens: 65_536,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
      responseModalities: ["TEXT", "IMAGE"],
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });
    const other = { responseModalities: ["TEXT", "AUDIO"], mediaResolution: "MEDIA_RESOLUTION_UNSPECIFIED" };
    expect(unsupported(() => prepareGeminiRequest({ ...hello, generationConfig: other }, GEMINI, strict))).toEqual([
      "generationConfig.responseModalities:AUDIO",
      "generationConfig.mediaResolution:MEDIA_RESOLUTION_UNSPECIFIED",
    ]);
    const p = prepareGeminiRequest({ ...hello, generationConfig: other }, GEMINI, lossy);
    expect(p.generationConfig).toEqual({ maxOutputTokens: 65_536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 }, responseModalities: ["TEXT"] });
    expect(p.dropped).toEqual(["generationConfig.responseModalities:AUDIO", "generationConfig.mediaResolution:MEDIA_RESOLUTION_UNSPECIFIED"]);
    const audioOnly = prepareGeminiRequest({ ...hello, generationConfig: { responseModalities: ["AUDIO"] } }, GEMINI, lossy);
    expect(audioOnly.generationConfig["responseModalities"]).toBeUndefined();
    expect(() => prepareGeminiRequest({ ...hello, generationConfig: { responseModalities: "IMAGE" } }, GEMINI, strict)).toThrow("responseModalities must be an array of strings");
    expect(() => prepareGeminiRequest({ ...hello, generationConfig: { responseModalities: [1] } }, GEMINI, strict)).toThrow("responseModalities must be an array of strings");
    expect(() => prepareGeminiRequest({ ...hello, generationConfig: { mediaResolution: 1 } }, GEMINI, strict)).toThrow("mediaResolution must be a string");
  });

  test("sampling fields proven in P0-LIVE E3 are carried; types are checked", () => {
    const config = { temperature: 0, topP: 0.5, topK: 5, stopSequences: ["5"], maxOutputTokens: 64 };
    expect(prepareGeminiRequest({ ...hello, generationConfig: config }, GEMINI, strict).generationConfig).toEqual({
      maxOutputTokens: 64,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
      temperature: 0,
      topP: 0.5,
      topK: 5,
      stopSequences: ["5"],
    });
    for (const [config, message] of [
      [1, "generationConfig must be an object"],
      [{ temperature: "hot" }, "temperature must be a number"],
      [{ topK: Number.NaN }, "topK must be a number"],
      [{ stopSequences: [1] }, "stopSequences must be an array of strings"],
      [{ stopSequences: "5" }, "stopSequences must be an array of strings"],
      [{ maxOutputTokens: 0 }, "positive integer"],
      [{ maxOutputTokens: 1.5 }, "positive integer"],
      [{ thinkingConfig: 1 }, "thinkingConfig must be an object"],
      [{ thinkingConfig: { includeThoughts: "yes" } }, "includeThoughts must be a boolean"],
      [{ thinkingConfig: { thinkingBudget: 1.5 } }, "thinkingBudget must be an integer"],
    ] as const) {
      expect(() => prepareGeminiRequest({ ...hello, generationConfig: config }, GEMINI, strict)).toThrow(message);
    }
  });

  test("maxOutputTokens above the catalog maximum: unsupported, or clamped with lossy; no catalog maximum keeps the client value", () => {
    const body = { ...hello, generationConfig: { maxOutputTokens: 70_000 } };
    expect(unsupported(() => prepareGeminiRequest(body, GEMINI, strict))).toEqual(["generationConfig.maxOutputTokens>65536"]);
    const clamped = prepareGeminiRequest(body, GEMINI, lossy);
    expect(clamped.generationConfig["maxOutputTokens"]).toBe(65_536);
    expect(clamped.dropped).toEqual(["generationConfig.maxOutputTokens>65536"]);
    expect(prepareGeminiRequest(body, NO_LIMIT, strict).generationConfig).toEqual({ maxOutputTokens: 70_000 });
    expect(prepareGeminiRequest(hello, NO_LIMIT, strict).generationConfig).toEqual({});
  });

  test("thinkingBudget is catalog-exact: the same value passes, another is unsupported or replaced with lossy", () => {
    const same = { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 1000, includeThoughts: false } } };
    expect(prepareGeminiRequest(same, GEMINI, strict).generationConfig["thinkingConfig"]).toEqual({ includeThoughts: false, thinkingBudget: 1000 });
    const other = { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } };
    expect(unsupported(() => prepareGeminiRequest(other, GEMINI, strict))).toEqual(["generationConfig.thinkingConfig.thinkingBudget:4096"]);
    expect(prepareGeminiRequest(other, GEMINI, lossy).generationConfig["thinkingConfig"]).toEqual({ includeThoughts: true, thinkingBudget: 1000 });
  });

  test("a model without a catalog budget: nothing injected; a client budget is unsupported (dropped with lossy); includeThoughts alone is kept", () => {
    expect(prepareGeminiRequest(hello, CLAUDE, strict).generationConfig).toEqual({ maxOutputTokens: 128_000 });
    const budget = { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } };
    expect(unsupported(() => prepareGeminiRequest(budget, CLAUDE, strict))).toEqual(["generationConfig.thinkingConfig.thinkingBudget:2048"]);
    expect(prepareGeminiRequest(budget, CLAUDE, lossy).generationConfig).toEqual({ maxOutputTokens: 128_000 });
    const include = { ...hello, generationConfig: { thinkingConfig: { includeThoughts: true } } };
    expect(prepareGeminiRequest(include, CLAUDE, strict).generationConfig).toEqual({ maxOutputTokens: 128_000, thinkingConfig: { includeThoughts: true } });
  });
});

describe("prepareGeminiRequest: systemInstruction", () => {
  test("text parts become a user-role system content; empty is omitted", () => {
    expect(prepareGeminiRequest({ ...hello, systemInstruction: { parts: [{ text: "be brief" }] } }, GEMINI, strict).systemInstruction).toEqual({ role: "user", parts: [{ text: "be brief" }] });
    expect(prepareGeminiRequest({ ...hello, systemInstruction: { role: "system", parts: [] } }, GEMINI, strict).systemInstruction).toBeUndefined();
  });

  test("malformed system instructions are invalid", () => {
    for (const [system, message] of [
      ["be brief", "systemInstruction must be a content"],
      [{ parts: "x" }, "systemInstruction must be a content"],
      [{ parts: [1] }, "parts[0] must be an object"],
      [{ parts: [{ text: 1 }] }, "parts[0].text must be a string"],
    ] as const) {
      expect(() => prepareGeminiRequest({ ...hello, systemInstruction: system }, GEMINI, strict)).toThrow(message);
    }
  });

  test("non-text system parts are unsupported; lossy keeps the text of a mixed part and skips a part without text", () => {
    const system = { parts: [{ text: "keep", thought: true }, { inlineData: { mimeType: "image/png", data: "AA" } }] };
    expect(unsupported(() => prepareGeminiRequest({ ...hello, systemInstruction: system }, GEMINI, strict))).toEqual(["systemInstruction.parts.thought", "systemInstruction.parts.inlineData"]);
    const p = prepareGeminiRequest({ ...hello, systemInstruction: system }, GEMINI, lossy);
    expect(p.systemInstruction).toEqual({ role: "user", parts: [{ text: "keep" }] });
    expect(p.dropped).toEqual(["systemInstruction.parts.thought", "systemInstruction.parts.inlineData"]);
  });
});

describe("prepareGeminiRequest: tools and toolConfig", () => {
  const getTime = { name: "get_time", description: "time", parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } };

  test("declarations are formatted as one tool per declaration (recon parity), types upper-cased (law 5), mode VALIDATED by default", () => {
    const p = prepareGeminiRequest({ ...hello, tools: [{ functionDeclarations: [getTime] }, { functionDeclarations: [{ name: "noop" }] }, {}] }, GEMINI, strict);
    expect(p.tools).toEqual([
      { functionDeclarations: [{ name: "get_time", description: "time", parameters: { type: "OBJECT", properties: { timezone: { type: "STRING" } }, required: ["timezone"] } }] },
      { functionDeclarations: [{ name: "noop" }] },
    ]);
    expect(p.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(prepareGeminiRequest({ ...hello, tools: [] }, GEMINI, strict).tools).toBeUndefined();
  });

  test("malformed tools are invalid", () => {
    for (const [tools, message] of [
      [{}, "tools must be an array"],
      [[1], "tools[0] must be an object"],
      [[{ functionDeclarations: {} }], "functionDeclarations must be an array"],
      [[{ functionDeclarations: [{}] }], "needs a string name"],
      [[{ functionDeclarations: [1] }], "needs a string name"],
    ] as const) {
      expect(() => prepareGeminiRequest({ ...hello, tools }, GEMINI, strict)).toThrow(message);
    }
  });

  test("other tool kinds, declaration fields and schema keywords are unsupported (decision Q2); lossy sanitizes", () => {
    const tools = [{ googleSearch: {} }, { functionDeclarations: [{ ...getTime, behavior: "BLOCKING", parameters: { ...getTime.parameters, additionalProperties: false, $schema: "s" } }] }];
    expect(unsupported(() => prepareGeminiRequest({ ...hello, tools }, GEMINI, strict))).toEqual(["tools.googleSearch", "tools.functionDeclarations.behavior", "tools.parameters.additionalProperties", "tools.parameters.$schema"]);
    const p = prepareGeminiRequest({ ...hello, tools }, GEMINI, lossy);
    expect(p.tools![0]!.functionDeclarations[0]).toEqual({ name: "get_time", description: "time", parameters: { type: "OBJECT", properties: { timezone: { type: "STRING" } }, required: ["timezone"] } });
  });

  test("parametersJsonSchema (the Gen AI SDK's form for $schema and MCP tools) travels unchanged (live L1 j1/j2)", () => {
    const schema = { type: "object", properties: { path: { type: "string" }, limit: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }], default: null } }, required: ["path"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" };
    const p = prepareGeminiRequest({ ...hello, tools: [{ functionDeclarations: [{ name: "read_file", description: "Read a text file.", parametersJsonSchema: schema }] }] }, GEMINI, strict);
    expect([p.tools, p.dropped]).toEqual([[{ functionDeclarations: [{ name: "read_file", description: "Read a text file.", parametersJsonSchema: schema }] }], []]);
  });

  test("functionCallingConfig: AUTO and VALIDATED pass; other modes and allowedFunctionNames are unsupported (B1)", () => {
    const withConfig = (functionCallingConfig: unknown) => ({ ...hello, tools: [{ functionDeclarations: [getTime] }], toolConfig: { functionCallingConfig } });
    expect(prepareGeminiRequest(withConfig({ mode: "AUTO" }), GEMINI, strict).toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(unsupported(() => prepareGeminiRequest(withConfig({ mode: "ANY", allowedFunctionNames: ["get_time"] }), GEMINI, strict))).toEqual([
      "toolConfig.functionCallingConfig.mode:ANY",
      "toolConfig.functionCallingConfig.allowedFunctionNames",
    ]);
    const dropped = prepareGeminiRequest(withConfig({ mode: "NONE" }), GEMINI, lossy);
    expect(dropped.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(dropped.dropped).toEqual(["toolConfig.functionCallingConfig.mode:NONE"]);
  });

  test("toolConfig shape: invalid values, foreign keys; kept without tools only when given", () => {
    expect(() => prepareGeminiRequest({ ...hello, toolConfig: 1 }, GEMINI, strict)).toThrow("toolConfig must be an object");
    expect(() => prepareGeminiRequest({ ...hello, toolConfig: { functionCallingConfig: 1 } }, GEMINI, strict)).toThrow("functionCallingConfig must be an object");
    expect(unsupported(() => prepareGeminiRequest({ ...hello, toolConfig: { retrievalConfig: {} } }, GEMINI, strict))).toEqual(["toolConfig.retrievalConfig"]);
    expect(prepareGeminiRequest({ ...hello, toolConfig: {} }, GEMINI, strict).toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });
});

describe("prepareGeminiRequest: wire laws 6, 7, 8 and 12 (always applied, always reported — decision Q3)", () => {
  const call = (id: string | undefined, name = "get_time", extra: Record<string, unknown> = {}) => ({ functionCall: { ...(id !== undefined ? { id } : {}), name, args: {} }, ...extra });
  const response = (id: string | undefined, name = "get_time") => ({ functionResponse: { ...(id !== undefined ? { id } : {}), name, response: { output: "13:00" } } });

  test("law 7: user-role function responses move to model-role contents, preserving order", () => {
    const body = { contents: [user("q"), { role: "model", parts: [call("c1", "get_time", { thoughtSignature: "S1" })] }, { role: "user", parts: [response("c1"), { text: "and?" }, response("c2")] }] };
    const p = prepareGeminiRequest(body, GEMINI, strict);
    expect(p.contents.map((c) => [c.role, c.parts.length])).toEqual([
      ["user", 1],
      ["model", 1],
      ["model", 1],
      ["user", 1],
      ["model", 1],
    ]);
    expect(p.turns.map((t) => t.role)).toEqual(["user", "assistant", "tool", "user", "tool"]);
  });

  test("law 6 (Gemini): signed calls kept; cached ids signed; unsigned calls dropped with their responses", () => {
    const body = {
      contents: [
        user("q"),
        { role: "model", parts: [{ text: "calling" }, call("signed", "a", { thoughtSignature: "S0" }), call("cached", "b"), call("lost", "c"), call(undefined, "d")] },
        { role: "model", parts: [response("signed", "a"), response("cached", "b"), response("lost", "c"), response(undefined, "d"), response(undefined, "e")] },
        user("next"),
      ],
    };
    const p = prepareGeminiRequest(body, GEMINI, { lossy: false, signatures: { cached: "S-CACHED" } });
    expect(p.contents[1]!.parts).toEqual([{ text: "calling" }, call("signed", "a", { thoughtSignature: "S0" }), call("cached", "b", { thoughtSignature: "S-CACHED" })]);
    expect(p.contents[2]!.parts).toEqual([response("signed", "a"), response("cached", "b"), response(undefined, "e")]);
    expect(p.dropped).toEqual(["unsigned_function_call:lost", "unsigned_function_call:d"]);
  });

  test("law 6 applies only to Gemini models: an unsigned call to a Claude-backed model is kept", () => {
    const body = { contents: [user("q"), { role: "model", parts: [call("toolu_1")] }, { role: "user", parts: [response("toolu_1")] }] };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(p.contents[1]!.parts).toEqual([call("toolu_1")]);
    expect(p.dropped).toEqual([]);
  });

  test("law 8 then law 12: content-free contents dropped, trailing model turns stripped, a trailing response kept", () => {
    const body = { contents: [user("q"), { role: "user", parts: [{ text: "  " }] }, { role: "model", parts: [call("x", "a", { thoughtSignature: "S" })] }, { role: "user", parts: [response("x", "a")] }, { role: "model", parts: [{ text: "prefill" }] }, { role: "model", parts: [{ thoughtSignature: "only" }] }] };
    const p = prepareGeminiRequest(body, GEMINI, strict);
    expect(p.contents.map((c) => c.role)).toEqual(["user", "model", "model"]);
    expect(p.dropped).toEqual(["empty_content", "trailing_model_turn"]);
  });
});

describe("prepareGeminiRequest: tool-call ids (uc-pi-7, AGENTS.md §3 antigravity tool-id law)", () => {
  const call = (id: string | undefined, name = "get_time", extra: Record<string, unknown> = {}) => ({ functionCall: { ...(id !== undefined ? { id } : {}), name, args: {} }, ...extra });
  const response = (id: string | undefined, name = "get_time") => ({ functionResponse: { ...(id !== undefined ? { id } : {}), name, response: { output: "13:00" } } });
  const ids = (parts: readonly Record<string, unknown>[], key: "functionCall" | "functionResponse") =>
    parts.map((part) => (part[key] as { id?: string } | undefined)?.id);

  test("R1: a Gemini target gets no synthesized id and no rewritten part [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=negative]", () => {
    const body = { contents: [user("q"), { role: "model", parts: [call(undefined, "get_time", { thoughtSignature: "S1" })] }, { role: "user", parts: [response(undefined)] }] };
    const p = prepareGeminiRequest(body, GEMINI, strict);
    expect(p.contents[1]!.parts).toEqual([call(undefined, "get_time", { thoughtSignature: "S1" })]);
    expect(p.contents[2]!.parts).toEqual([response(undefined)]);
    expect(p.dropped).toEqual([]);
  });

  test("R2: an id the client sent is never rewritten, on a call or on a response [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=positive]", () => {
    const body = { contents: [user("q"), { role: "model", parts: [call("toolu_9")] }, { role: "user", parts: [response("toolu_9")] }] };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(p.contents[1]!.parts).toEqual([call("toolu_9")]);
    expect(p.contents[2]!.parts).toEqual([response("toolu_9")]);
  });

  test("R3: a synthesized id is ap_call_<n> from 1, deterministic per request, and skips every id the request carries [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=positive]", () => {
    const body = {
      contents: [
        user("q"),
        { role: "model", parts: [call("ap_call_1", "a"), call(undefined, "b"), call(undefined, "c")] },
        { role: "user", parts: [response("ap_call_1", "a"), response(undefined, "b"), response(undefined, "c")] },
      ],
    };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(ids(p.contents[1]!.parts, "functionCall")).toEqual(["ap_call_1", "ap_call_2", "ap_call_3"]);
    expect(ids(p.contents[2]!.parts, "functionResponse")).toEqual(["ap_call_1", "ap_call_2", "ap_call_3"]);
    expect(prepareGeminiRequest(body, CLAUDE, strict).contents).toEqual(p.contents);
  });

  test("R4: a response without an id takes the earliest unpaired call of its name, so parallel calls of one tool pair FIFO [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=positive]", () => {
    const body = {
      contents: [
        user("q"),
        { role: "model", parts: [call(undefined, "a"), call(undefined, "get_time"), call(undefined, "b"), call(undefined, "get_time")] },
        { role: "user", parts: [response(undefined, "get_time"), response(undefined, "get_time")] },
      ],
    };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(ids(p.contents[1]!.parts, "functionCall")).toEqual(["ap_call_1", "ap_call_2", "ap_call_3", "ap_call_4"]);
    expect(ids(p.contents[2]!.parts, "functionResponse")).toEqual(["ap_call_2", "ap_call_4"]);
  });

  test("R5: a response with no preceding call gets a fresh id and is forwarded, never dropped [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=negative]", () => {
    const body = { contents: [user("q"), { role: "user", parts: [response(undefined, "orphan")] }] };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(p.contents.map((c) => c.role)).toEqual(["user", "model"]);
    expect(p.contents[1]!.parts).toEqual([response("ap_call_1", "orphan")]);
    expect(p.dropped).toEqual([]);
  });

  test("R6: synthesizing an id adds no dropped entry [feature=pi-inference use-case=uc-pi-7 tier=unit polarity=negative]", () => {
    const body = { contents: [user("q"), { role: "model", parts: [call(undefined)] }, { role: "user", parts: [response(undefined)] }] };
    const p = prepareGeminiRequest(body, CLAUDE, strict);
    expect(p.dropped).toEqual([]);
    expect(p.contents[1]!.parts).toEqual([call("ap_call_1")]);
  });
});

describe("turnView", () => {
  test("roles, visible text, tool calls with and without ids", () => {
    expect(
      turnView([
        { role: "user", parts: [{ text: "a" }, { text: "b" }, { inlineData: {} }] },
        { role: "model", parts: [{ text: "hidden", thought: true }, { text: "shown" }, { functionCall: { id: "1", name: "f", args: { x: 1 } } }, { functionCall: { name: "g" } }] },
        { role: "model", parts: [{ text: "plain" }] },
        { role: "model", parts: [{ functionResponse: { name: "f" } }] },
      ]),
    ).toEqual([
      { role: "user", text: "ab" },
      {
        role: "assistant",
        text: "shown",
        toolCalls: [
          { id: "1", name: "f", arguments: '{"x":1}' },
          { id: "g", name: "g", arguments: "{}" },
        ],
      },
      { role: "assistant", text: "plain" },
      { role: "tool", text: "" },
    ]);
  });
});

describe("innerRequest", () => {
  const snapshot: TrajectorySnapshot = {
    requestId: "agent/a/1/t/3",
    sessionId: "-9223372036854775808",
    labels: { last_step_index: "2", model_enum: "M", trajectory_id: "t", used_claude: "false", used_claude_conservative: "false", used_non_gemini_model: "false" },
  };

  test("captured key order; the int64 sessionId stays a decimal string", () => {
    const full = prepareGeminiRequest({ ...hello, systemInstruction: { parts: [{ text: "s" }] }, tools: [{ functionDeclarations: [{ name: "f" }] }] }, GEMINI, strict);
    const body = innerRequest(full, snapshot);
    expect(Object.keys(body)).toEqual(["contents", "systemInstruction", "tools", "toolConfig", "labels", "generationConfig", "sessionId"]);
    expect(JSON.stringify(body)).toContain('"sessionId":"-9223372036854775808"');
    expect(Object.keys(innerRequest(prepareGeminiRequest(hello, GEMINI, strict), snapshot))).toEqual(["contents", "labels", "generationConfig", "sessionId"]);
  });
});

describe("signedCalls", () => {
  test("only id-bearing signed functionCall parts of the first candidate", () => {
    const response = (parts: unknown): GeminiResponse => ({ candidates: [{ content: { parts } }] });
    expect(signedCalls(response([{ functionCall: { id: "a", name: "f" }, thoughtSignature: "S" }, { functionCall: { name: "g" }, thoughtSignature: "T" }, { functionCall: { id: "b" } }, { text: "x", thoughtSignature: "U" }, { functionCall: 1, thoughtSignature: "V" }, 7]))).toEqual([
      { id: "a", signature: "S" },
    ]);
    expect(signedCalls({})).toEqual([]);
    expect(signedCalls({ candidates: [1] })).toEqual([]);
    expect(signedCalls({ candidates: [{}] })).toEqual([]);
    expect(signedCalls(response("x"))).toEqual([]);
  });
});

describe("aggregateResponses (decision Q4)", () => {
  const sample = readFileSync(join(import.meta.dir, "..", "fixtures", "plugin-5c6f7c2", "stream-generate.sample.sse"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => (JSON.parse(l.slice(5)) as { response: GeminiResponse }).response);

  test("the plugin's captured stream: text joined, the signature kept, last finishReason/usage/ids", () => {
    const merged = aggregateResponses(sample);
    expect(merged["candidates"]).toEqual([{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Hello, world!", thoughtSignature: "c2FtcGxlLXNpZ25hdHVyZQ==" }] } }]);
    expect(merged["usageMetadata"]).toEqual(sample[2]!["usageMetadata"]);
    expect(merged["responseId"]).toBe("resp-1");
  });

  test("a live P0-LIVE tool-loop stream (Gemini, signed call) keeps the call and its signature", () => {
    const capture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "tests", "fixtures", "captures", "p0-live", "t2-s2-tool-loop.json"), "utf8")) as {
      exchanges: { response: { chunks: { text: string }[] } }[];
    };
    const responses = capture.exchanges[0]!.response.chunks
      .map((c) => c.text)
      .join("")
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => (JSON.parse(l.slice(5)) as { response: GeminiResponse }).response);
    const parts = (aggregateResponses(responses)["candidates"] as { content: { parts: Record<string, unknown>[] } }[])[0]!.content.parts;
    const call = parts.find((p) => p["functionCall"] !== undefined)!;
    expect((call["functionCall"] as { name: string }).name).toBe("get_time");
    expect(typeof call["thoughtSignature"]).toBe("string");
  });

  test("thought and answer text stay separate; non-text parts break runs; malformed pieces are skipped", () => {
    const merged = aggregateResponses([
      { candidates: [{ content: { parts: [{ text: "t1", thought: true }, { text: "t2", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "a" }, { functionCall: { name: "f" }, thoughtSignature: "S" }, { text: "b" }, 3] }, safetyRatings: [] }] },
      { usageMetadata: { totalTokenCount: 9 } },
      { candidates: [{ content: "odd" }] },
      { candidates: [{ content: { parts: [{ text: "c", thoughtSignature: "Z" }] }, finishReason: "MAX_TOKENS" }] },
    ]);
    expect(merged).toEqual({
      candidates: [
        {
          safetyRatings: [],
          finishReason: "MAX_TOKENS",
          content: { role: "model", parts: [{ text: "t1t2", thought: true }, { text: "a" }, { functionCall: { name: "f" }, thoughtSignature: "S" }, { text: "bc", thoughtSignature: "Z" }] },
        },
      ],
      usageMetadata: { totalTokenCount: 9 },
    });
    expect(aggregateResponses([])).toEqual({ candidates: [{ content: { role: "model", parts: [] } }] });
  });
});
