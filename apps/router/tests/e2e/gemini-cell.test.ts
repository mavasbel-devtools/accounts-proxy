// The near-native Gemini → antigravity cell, black-box: every validation and mapping rule of the cell is driven through
// the daemon's HTTP route (P4 plan §2.3, decisions Q2–Q4, amendment B1), and the request the upstream really received
// is asserted from the replay server's record. Scripted upstream answers cover the stream shapes the cell must handle.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { removeTemporary } from "@inference-router/test-support/temporary.ts";
import { startSignedInDaemon, type SignedInDaemon } from "@inference-router/test-support/e2e/router-process.ts";
import { brokenStream, envelopeStream, jsonResponse, ReplayUpstreams } from "@inference-router/test-support/e2e/upstreams.ts";

const upstreams = new ReplayUpstreams();
let env: SignedInDaemon;
beforeAll(async () => {
  upstreams.start();
  env = await startSignedInDaemon(upstreams.seamEnv());
});
afterAll(async () => {
  await env.daemon.stop();
  upstreams.stop();
  removeTemporary(env.home.dir);
});
afterEach(() => upstreams.reset());

const GENERATE = "/v1internal:streamGenerateContent";
type Answer = { status: number; body: Record<string, unknown>; text: string; headers: Headers };

async function call(body: unknown, options: { model?: string; method?: string; lossy?: boolean; query?: string } = {}): Promise<Answer> {
  const model = encodeURIComponent(`antigravity/${options.model ?? "gemini-3.6-flash-low"}`);
  const res = await fetch(`${env.daemon.url}/gemini/v1beta/models/${model}:${options.method ?? "generateContent"}${options.query ?? ""}`, {
    method: "POST",
    headers: { "x-goog-api-key": env.token, "content-type": "application/json", ...(options.lossy ? { "x-router-lossy": "1" } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const sent = () => (JSON.parse(upstreams.find(GENERATE).at(-1)!.body) as { request: Record<string, unknown> }).request;
const message = (a: Answer) => (a.body["error"] as { message: string }).message;
const user = (text: string) => ({ role: "user", parts: [{ text }] });
const hello = { contents: [user("hi")] };

describe("routing and models", () => {
  test("an unknown method is a 400; an unknown model a 404; countTokens a 400 naming the feature", async () => {
    const embed = await call(hello, { method: "embedContent" });
    expect([embed.status, message(embed)]).toEqual([400, "antigravity has no native route /v1beta/models/antigravity%2Fgemini-3.6-flash-low:embedContent"]);
    const unknown = await call(hello, { model: "nope" });
    expect([unknown.status, (unknown.body["error"] as { status: string }).status]).toEqual([404, "NOT_FOUND"]);
    expect((await call(hello, { method: "countTokens" })).status).toBe(400);
  });
});

describe("request validation (400 INVALID_ARGUMENT, nothing sent upstream)", () => {
  test.each([
    ["not JSON", "{oops", "not valid JSON"],
    ["an array body", [1], "request body must be a JSON object"],
    ["contents not an array", { contents: {} }, "contents must be an array"],
    ["a content that is not an object", { contents: [1] }, "contents[0] must be an object"],
    ["an unknown role", { contents: [{ role: "system", parts: [] }] }, 'contents[0].role must be "user" or "model"'],
    ["parts not an array", { contents: [{ role: "user" }] }, "contents[0].parts must be an array"],
    ["a part that is not an object", { contents: [{ parts: [1] }] }, "contents[0].parts[0] must be an object"],
    ["text that is not a string", { contents: [{ parts: [{ text: 1 }] }] }, "text must be a string"],
    ["inlineData that is not an object", { contents: [{ parts: [{ inlineData: "x" }] }] }, "inlineData needs"],
    ["inlineData without mimeType", { contents: [{ parts: [{ inlineData: { data: "AA" } }] }] }, "inlineData needs"],
    ["inlineData without data", { contents: [{ parts: [{ inlineData: { mimeType: "image/png" } }] }] }, "inlineData needs"],
    ["a functionCall without a name", { contents: [{ parts: [{ functionCall: {} }] }] }, "functionCall needs a string name"],
    ["a functionResponse that is not an object", { contents: [{ parts: [{ functionResponse: 1 }] }] }, "functionResponse needs a string name"],
    ["no turn left", { contents: [{ role: "model", parts: [{ text: "prefill" }] }] }, "no turn left"],
    ["systemInstruction not a content", { ...hello, systemInstruction: "be brief" }, "systemInstruction must be a content"],
    ["systemInstruction parts not an array", { ...hello, systemInstruction: { parts: "x" } }, "systemInstruction must be a content"],
    ["a system part that is not an object", { ...hello, systemInstruction: { parts: [1] } }, "systemInstruction.parts[0] must be an object"],
    ["a system part without text", { ...hello, systemInstruction: { parts: [{ text: 1 }] } }, "systemInstruction.parts[0].text must be a string"],
    ["tools not an array", { ...hello, tools: {} }, "tools must be an array"],
    ["a tool that is not an object", { ...hello, tools: [1] }, "tools[0] must be an object"],
    ["functionDeclarations not an array", { ...hello, tools: [{ functionDeclarations: {} }] }, "functionDeclarations must be an array"],
    ["a declaration without a name", { ...hello, tools: [{ functionDeclarations: [{}] }] }, "needs a string name"],
    ["toolConfig not an object", { ...hello, toolConfig: 1 }, "toolConfig must be an object"],
    ["functionCallingConfig not an object", { ...hello, toolConfig: { functionCallingConfig: 1 } }, "functionCallingConfig must be an object"],
    ["generationConfig not an object", { ...hello, generationConfig: 1 }, "generationConfig must be an object"],
    ["temperature not a number", { ...hello, generationConfig: { temperature: "hot" } }, "temperature must be a number"],
    ["topP not finite", { ...hello, generationConfig: { topP: "1e999" } }, "topP must be a number"],
    ["stopSequences not an array", { ...hello, generationConfig: { stopSequences: "5" } }, "stopSequences must be an array of strings"],
    ["stopSequences with a number", { ...hello, generationConfig: { stopSequences: [5] } }, "stopSequences must be an array of strings"],
    ["maxOutputTokens not a number", { ...hello, generationConfig: { maxOutputTokens: "64" } }, "positive integer"],
    ["maxOutputTokens not an integer", { ...hello, generationConfig: { maxOutputTokens: 1.5 } }, "positive integer"],
    ["maxOutputTokens zero", { ...hello, generationConfig: { maxOutputTokens: 0 } }, "positive integer"],
    ["thinkingConfig not an object", { ...hello, generationConfig: { thinkingConfig: 1 } }, "thinkingConfig must be an object"],
    ["includeThoughts not a boolean", { ...hello, generationConfig: { thinkingConfig: { includeThoughts: "yes" } } }, "includeThoughts must be a boolean"],
    ["thinkingBudget not a number", { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: "1000" } } }, "thinkingBudget must be an integer"],
    ["thinkingBudget not an integer", { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 1.5 } } }, "thinkingBudget must be an integer"],
  ])("%s", async (_name, body, expected) => {
    const before = upstreams.find(GENERATE).length;
    const answer = await call(body);
    expect([answer.status, (answer.body["error"] as { status: string }).status]).toEqual([400, "INVALID_ARGUMENT"]);
    expect(message(answer)).toContain(expected);
    expect(upstreams.find(GENERATE).length).toBe(before);
  });
});

describe("strict translation: unknown fields are 400 unsupported_feature; x-router-lossy drops and reports them", () => {
  test.each([
    ["an unknown top-level field", { ...hello, safetySettings: [] }, "safetySettings"],
    ["an unknown part field", { contents: [{ parts: [{ text: "a", fileData: {} }] }] }, "contents.parts.fileData"],
    ["a non-text system part", { ...hello, systemInstruction: { parts: [{ text: "keep", thought: true }, { inlineData: { mimeType: "image/png", data: "AA" } }] } }, "systemInstruction.parts.thought,systemInstruction.parts.inlineData"],
    ["another tool kind", { ...hello, tools: [{ googleSearch: {} }] }, "tools.googleSearch"],
    ["a declaration field", { ...hello, tools: [{ functionDeclarations: [{ name: "f", behavior: "BLOCKING" }] }] }, "tools.functionDeclarations.behavior"],
    ["a schema keyword Antigravity rejects", { ...hello, tools: [{ functionDeclarations: [{ name: "f", parameters: { type: "object", additionalProperties: false } }] }] }, "tools.parameters.additionalProperties"],
    ["a toolConfig field", { ...hello, toolConfig: { retrievalConfig: {} } }, "toolConfig.retrievalConfig"],
    ["a function-calling mode the upstream ignores (B1)", { ...hello, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } } }, "toolConfig.functionCallingConfig.mode:ANY,toolConfig.functionCallingConfig.allowedFunctionNames"],
    ["a mode that is not a string", { ...hello, toolConfig: { functionCallingConfig: { mode: 3 } } }, "toolConfig.functionCallingConfig.mode:3"],
    ["a generationConfig field", { ...hello, generationConfig: { responseMimeType: "application/json" } }, "generationConfig.responseMimeType"],
    ["a thinkingConfig field", { ...hello, generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }, "generationConfig.thinkingConfig.thinkingLevel"],
    ["maxOutputTokens above the catalog maximum", { ...hello, generationConfig: { maxOutputTokens: 70_000 } }, "generationConfig.maxOutputTokens>65536"],
    ["a thinkingBudget other than the catalog's", { ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }, "generationConfig.thinkingConfig.thinkingBudget:4096"],
  ])("%s", async (_name, body, features) => {
    const strict = await call(body);
    expect([strict.status, message(strict)]).toEqual([400, `antigravity (Gemini cell) cannot carry: ${features.split(",").join(", ")}`]);
    const lossy = await call(body, { lossy: true });
    expect([lossy.status, lossy.headers.get("x-router-dropped")]).toEqual([200, features]);
  });

  test("lossy keeps what can be carried: the text of a mixed system part, the catalog maximum and budget", async () => {
    await call({ ...hello, systemInstruction: { parts: [{ text: "keep", thought: true }, { inlineData: { mimeType: "image/png", data: "AA" } }] }, generationConfig: { maxOutputTokens: 70_000, thinkingConfig: { thinkingBudget: 4096 } }, toolConfig: { functionCallingConfig: { mode: "NONE" } } }, { lossy: true });
    const request = sent();
    expect(request["systemInstruction"]).toEqual({ role: "user", parts: [{ text: "keep" }] });
    expect(request["generationConfig"]).toEqual({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } });
    expect(request["toolConfig"]).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });
});

describe("mapping onto the upstream request", () => {
  test("carried fields: system text, tools (law 5), AUTO mode, sampling, the catalog budget when equal, includeThoughts", async () => {
    const body = {
      contents: [{ parts: [{ text: "what?" }, { inlineData: { mimeType: "image/png", data: "AA" } }] }],
      systemInstruction: { role: "system", parts: [{ text: "be brief" }] },
      tools: [{ functionDeclarations: [{ name: "get_time", description: "time", parameters: { type: "object", properties: { tz: { type: "string" } } } }, { name: "noop" }] }, {}],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0, topP: 0.5, topK: 5, stopSequences: ["5"], maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 1000, includeThoughts: false } },
    };
    expect((await call(body)).status).toBe(200);
    const request = sent();
    expect(Object.keys(request)).toEqual(["contents", "systemInstruction", "tools", "toolConfig", "labels", "generationConfig", "sessionId"]);
    expect(request["contents"]).toEqual([{ role: "user", parts: body.contents[0]!.parts }]);
    expect(request["systemInstruction"]).toEqual({ role: "user", parts: [{ text: "be brief" }] });
    expect(request["tools"]).toEqual([{ functionDeclarations: [{ name: "get_time", description: "time", parameters: { type: "OBJECT", properties: { tz: { type: "STRING" } } } }, { name: "noop" }] }]);
    expect(request["toolConfig"]).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(request["generationConfig"]).toEqual({ maxOutputTokens: 64, thinkingConfig: { includeThoughts: false, thinkingBudget: 1000 }, temperature: 0, topP: 0.5, topK: 5, stopSequences: ["5"] });
  });

  test("an empty system instruction and empty tools are omitted; toolConfig alone gets VALIDATED", async () => {
    await call({ ...hello, systemInstruction: { parts: [] }, tools: [], toolConfig: {} });
    const request = sent();
    expect("systemInstruction" in request || "tools" in request).toBe(false);
    expect(request["toolConfig"]).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });

  test("a model without catalog limits or budget (chat_20706): no maxOutputTokens injected, the client's kept, a budget refused, includeThoughts alone kept", async () => {
    await call(hello, { model: "chat_20706" });
    expect(sent()["generationConfig"]).toEqual({});
    await call({ ...hello, generationConfig: { maxOutputTokens: 70_000, thinkingConfig: { includeThoughts: true } } }, { model: "chat_20706" });
    expect(sent()["generationConfig"]).toEqual({ maxOutputTokens: 70_000, thinkingConfig: { includeThoughts: true } });
    const budget = await call({ ...hello, generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, { model: "chat_20706" });
    expect(message(budget)).toBe("antigravity (Gemini cell) cannot carry: generationConfig.thinkingConfig.thinkingBudget:2048");
  });

  test("law 7: user-role function responses move into model-role contents, splitting runs in order", async () => {
    const answer = await call({
      contents: [
        user("q"),
        { role: "model", parts: [{ functionCall: { id: "c1", name: "f", args: {} }, thoughtSignature: "S1" }] },
        { role: "user", parts: [{ functionResponse: { id: "c1", name: "f", response: {} } }, { text: "and?" }, { functionResponse: { id: "c1", name: "f", response: {} } }] },
      ],
    });
    expect(answer.status).toBe(200);
    expect((sent()["contents"] as { role: string }[]).map((c) => c.role)).toEqual(["user", "model", "model", "user", "model"]);
  });

  test("law 6: signed calls kept, cached signatures applied, unsigned calls dropped with their responses and reported", async () => {
    upstreams.script(GENERATE, () => envelopeStream({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "cached", name: "b", args: {} }, thoughtSignature: "S-CACHED" }] }, finishReason: "STOP" }] }));
    await call(hello);
    const answer = await call({
      contents: [
        user("q"),
        { role: "model", parts: [{ text: "calling" }, { functionCall: { id: "signed", name: "a", args: {} }, thoughtSignature: "S0" }, { functionCall: { id: "cached", name: "b", args: {} } }, { functionCall: { id: "lost", name: "c", args: {} } }, { functionCall: { name: "d", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "signed", name: "a", response: {} } }, { functionResponse: { id: "cached", name: "b", response: {} } }, { functionResponse: { id: "lost", name: "c", response: {} } }, { functionResponse: { name: "d", response: {} } }, { functionResponse: { name: "e", response: {} } }, { text: "next" }] },
      ],
    });
    expect([answer.status, answer.headers.get("x-router-dropped")]).toEqual([200, "unsigned_function_call:lost,unsigned_function_call:d"]);
    const contents = sent()["contents"] as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]!.parts).toEqual([{ text: "calling" }, { functionCall: { id: "signed", name: "a", args: {} }, thoughtSignature: "S0" }, { functionCall: { id: "cached", name: "b", args: {} }, thoughtSignature: "S-CACHED" }]);
    expect(contents[2]!.parts.map((p) => (p["functionResponse"] as { name: string }).name)).toEqual(["a", "b", "e"]);
  });

  test("law 6 applies only to Gemini models: an unsigned call to another model is kept", async () => {
    const answer = await call({ contents: [user("q"), { role: "model", parts: [{ functionCall: { id: "t1", name: "f", args: {} } }] }, { role: "user", parts: [{ functionResponse: { id: "t1", name: "f", response: {} } }] }] }, { model: "chat_20706" });
    expect([answer.status, answer.headers.get("x-router-dropped")]).toEqual([200, null]);
  });

  test("laws 8 and 12: empty contents dropped, trailing model turns stripped, each kind reported once", async () => {
    const answer = await call({ contents: [user("q"), { role: "user", parts: [] }, { role: "user", parts: [{ text: "  " }] }, { role: "model", parts: [{ text: "prefill" }] }] });
    expect([answer.status, answer.headers.get("x-router-dropped")]).toEqual([200, "empty_content,trailing_model_turn"]);
    expect(sent()["contents"]).toEqual([user("q")]);
  });
});

describe("upstream answers", () => {
  test("generateContent merges odd stream shapes: thoughts, non-text parts, id-less signed calls, malformed pieces", async () => {
    upstreams.script(GENERATE, () =>
      envelopeStream(
        { candidates: [{ content: { parts: [{ text: "t1", thought: true }, { text: "t2", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: "a" }, { functionCall: { name: "f" }, thoughtSignature: "S" }, { text: "b" }, 3] }, safetyRatings: [] }] },
        { usageMetadata: { totalTokenCount: 9 } },
        { candidates: "odd" },
        { candidates: [{ content: "odd" }] },
        { candidates: [{ content: { parts: "odd" } }] },
        { candidates: [{ content: { parts: [{ text: "c", thoughtSignature: "Z" }] }, finishReason: "MAX_TOKENS" }] },
      ),
    );
    const answer = await call(hello);
    expect(answer.body).toEqual({
      candidates: [{ safetyRatings: [], finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "t1t2", thought: true }, { text: "a" }, { functionCall: { name: "f" }, thoughtSignature: "S" }, { text: "bc", thoughtSignature: "Z" }] } }],
      usageMetadata: { totalTokenCount: 9 },
    });
  });

  test("a JSON (non-SSE) upstream body is accepted as the stream", async () => {
    upstreams.script(GENERATE, () => jsonResponse([{ response: { candidates: [{ content: { role: "model", parts: [{ text: "json" }] }, finishReason: "STOP" }] } }]));
    expect((await call(hello)).body["candidates"]).toEqual([{ finishReason: "STOP", content: { role: "model", parts: [{ text: "json" }] } }]);
  });

  test("an empty upstream stream is a 502, for both methods", async () => {
    upstreams.script(GENERATE, () => new Response("", { headers: { "content-type": "text/event-stream" } }), () => new Response("", { headers: { "content-type": "text/event-stream" } }));
    expect((await call(hello)).status).toBe(502);
    expect((await call(hello, { method: "streamGenerateContent", query: "?alt=sse" })).status).toBe(502);
  });

  test("upstream errors before the first byte: the Google body verbatim, a non-Google body wrapped as UNKNOWN", async () => {
    upstreams.script(GENERATE, () => jsonResponse({ error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }, 403), () => jsonResponse(["odd"], 418), () => jsonResponse({ detail: "x" }, 500), () => jsonResponse("null", 503));
    const google = await call(hello);
    expect([google.status, google.body]).toEqual([403, { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }]);
    const teapot = await call(hello);
    expect([teapot.status, (teapot.body["error"] as { status: string }).status]).toEqual([418, "UNKNOWN"]);
    expect(((await call(hello)).body["error"] as { status: string }).status).toBe("INTERNAL");
    expect(((await call(hello)).body["error"] as { status: string }).status).toBe("UNAVAILABLE");
  });

  test("a failure after the first byte ends the stream with a Google error element (router error and connection reset)", async () => {
    const first = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] } })}\n\n`;
    upstreams.script(GENERATE, () => brokenStream(first));
    const sse = await call(hello, { method: "streamGenerateContent", query: "?alt=sse" });
    const frames = sse.text.split("\r\n\r\n").filter((f) => f !== "");
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[1]!.slice(6))).toEqual({ error: { code: 500, message: "internal router error (details are in the router log)", status: "INTERNAL" } });
    upstreams.script(GENERATE, () => new Response(`${first}data: {"error"`, { headers: { "content-type": "application/json" } }));
    expect((await call(hello, { method: "streamGenerateContent" })).status).toBe(502);
  });
});
