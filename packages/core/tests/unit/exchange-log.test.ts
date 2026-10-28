import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BodyRecorder,
  CREDENTIAL_HEADERS,
  headerPairs,
  recordBody,
  redactEntry,
  Redactor,
  REQUEST_CREDENTIAL_FIELDS,
  RESPONSE_CREDENTIAL_FIELDS,
  TOKEN_MIN_TAIL,
  TOKEN_PREFIXES,
  tokenUsage,
} from "@accounts-proxy/core/domain/exchange-log.ts";

const redactor = new Redactor((value) => `fp${value.length}`);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("exchange log: bodies", () => {
  test("BodyRecorder keeps each chunk's time and size, joins a character split across chunks, and base64 for non-UTF-8", () => {
    const text = new BodyRecorder(100);
    expect(text.firstByteAfterMs).toBeUndefined();
    const euro = utf8("a€");
    text.add(euro.subarray(0, 2), 110);
    text.add(euro.subarray(2), 125);
    expect(text.chunks).toEqual([
      { t: 10, bytes: 2 },
      { t: 25, bytes: 2 },
    ]);
    expect(text.firstByteAfterMs).toBe(10);
    expect(text.body()).toEqual({ encoding: "utf8", text: "a€", bytes: 4 });
    const binary = new BodyRecorder(0);
    binary.add(new Uint8Array([0xff, 0x00, 0x41]), 1);
    expect(binary.body()).toEqual({ encoding: "base64", text: "/wBB", bytes: 3 });
    expect(new BodyRecorder(0).body()).toEqual({ encoding: "utf8", text: "", bytes: 0 });
  });

  test("recordBody: none, text (byte length), UTF-8 bytes, other bytes as base64; a body over 32 KiB of bytes", () => {
    expect(recordBody(undefined)).toEqual({ encoding: "utf8", text: "", bytes: 0 });
    expect(recordBody("é")).toEqual({ encoding: "utf8", text: "é", bytes: 2 });
    expect(recordBody(utf8("hi"))).toEqual({ encoding: "utf8", text: "hi", bytes: 2 });
    expect(recordBody(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toEqual({ encoding: "base64", text: "KLUv/Q==", bytes: 4 });
    const big = new Uint8Array(70_000).fill(0xff);
    expect(Buffer.from(recordBody(big).text, "base64")).toEqual(Buffer.from(big));
  });

  test("headerPairs: pairs are copied as sent, a record's entries in insertion order", () => {
    expect(headerPairs([["X-A", "1"], ["x-a", "2"]])).toEqual([["X-A", "1"], ["x-a", "2"]]);
    expect(headerPairs({ b: "1", a: "2" })).toEqual([["b", "1"], ["a", "2"]]);
  });
});

describe("exchange log: token usage (X3)", () => {
  test("Anthropic Messages, non-streamed: every field verbatim, the 5m/1h cache writes", () => {
    const body = JSON.stringify({
      usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 }, output_tokens: 7, service_tier: "standard" },
    });
    expect(tokenUsage(body)).toEqual({
      raw: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 }, output_tokens: 7, service_tier: "standard" },
      tokens: { input: 3, output: 7, cacheRead: 20, cacheWrite: 10, cacheWrite5m: 4, cacheWrite1h: 6 },
    });
  });

  test("Anthropic Messages, streamed: message_start then message_delta, the later usage object restating each key", () => {
    const sse = [
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 1 }, output_tokens: 1 } } })}`,
      "",
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42, cache_creation: { ephemeral_1h_input_tokens: 2 } } })}`,
      "data: [DONE]",
      "data: {not json",
      "",
    ].join("\n");
    expect(tokenUsage(sse)).toEqual({
      raw: { input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 2 }, output_tokens: 42 },
      tokens: { input: 5, output: 42, cacheWrite1h: 2 },
    });
  });

  test("OpenAI Chat (with OpenRouter's cache write), OpenAI Responses, Gemini/Antigravity", () => {
    expect(
      tokenUsage(JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } } }))!.tokens,
    ).toEqual({ input: 9, output: 4, cacheRead: 2, cacheWrite: 3, reasoning: 1, total: 13 });
    const responses = `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 5 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 10 } } })}\r\n`;
    expect(tokenUsage(responses)!.tokens).toEqual({ input: 8, output: 2, cacheRead: 5, reasoning: 1, total: 10 });
    const gemini = JSON.stringify([{ response: { usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 12, cachedContentTokenCount: 2, thoughtsTokenCount: 3, toolUsePromptTokenCount: 1 } } }]);
    expect(tokenUsage(gemini)!.tokens).toEqual({ input: 6, output: 3, cacheRead: 2, reasoning: 3, toolUsePrompt: 1, total: 12 });
  });

  test("no usage, a usage that is not an object, a non-numeric count, and plain text", () => {
    expect(tokenUsage('{"id":"x","usage":null}')).toBeUndefined();
    expect(tokenUsage("hello")).toBeUndefined();
    expect(tokenUsage("")).toBeUndefined();
    expect(tokenUsage('{"usage":{"input_tokens":"3","output_tokens":1}}')).toEqual({ raw: { input_tokens: "3", output_tokens: 1 }, tokens: { output: 1 } });
  });
});

describe("exchange log: redaction (X4)", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.payloadpayload.sig";
  test("the prefix list equals the recon manifest's (one list of known credential prefixes)", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "scripts", "recon", "shared", "redaction.json"), "utf8"));
    expect(TOKEN_PREFIXES).toEqual(manifest.tokenPrefixes);
    expect(TOKEN_MIN_TAIL).toBe(manifest.tokenBodyMinTail);
    expect([...CREDENTIAL_HEADERS]).toEqual(manifest.credentialHeaders);
    for (const field of manifest.queryCredentialFields) expect(REQUEST_CREDENTIAL_FIELDS.has(field)).toBe(true);
    for (const field of manifest.credentialFields) expect(REQUEST_CREDENTIAL_FIELDS.has(field) || RESPONSE_CREDENTIAL_FIELDS.has(field)).toBe(true);
  });

  test("headers: credential headers by name in any case; a prefixed credential anywhere else; the rest kept", () => {
    expect(redactor.headers([["Authorization", "Bearer abc"], ["X-Other", `k ${jwt}`], ["user-agent", "opencode/2.1.1"]])).toEqual([
      ["Authorization", "[redacted sha256:fp10 len:10]"],
      ["X-Other", `k [redacted sha256:fp${jwt.length} len:${jwt.length}]`],
      ["user-agent", "opencode/2.1.1"],
    ]);
    expect(redactor.text("sk-ant-short")).toBe("sk-ant-short");
    expect(redactor.text("sk-ant-oat01-abcdefgh")).toBe("[redacted sha256:fp21 len:21]");
  });

  test("query and URL: credential parameters (encoded or not), other parameters kept, a URL without a query", () => {
    expect(redactor.query({ code: "C0DE", state: "s" })).toEqual({ code: "[redacted sha256:fp4 len:4]", state: "s" });
    expect(redactor.url("https://h/cb?code=a%2Bb&state=s&flag&key")).toBe(`https://h/cb?code=${encodeURIComponent("[redacted sha256:fp3 len:3]")}&state=s&flag&key`);
    expect(redactor.url(`https://h/p/${jwt}`)).toBe(`https://h/p/[redacted sha256:fp${jwt.length} len:${jwt.length}]`);
    // A malformed escape decodes as URLSearchParams does (U+FFFD), and the value is still redacted.
    expect(redactor.url("https://h/cb?code=%E0%A4%A")).toBe("https://h/cb?code=%5Bredacted%20sha256%3Afp3%20len%3A3%5D");
  });

  test("bodies: JSON top-level fields, a form, plain text; base64 kept as it is", () => {
    const fields = REQUEST_CREDENTIAL_FIELDS;
    expect(redactor.body(recordBody('{"refresh_token":"rt","grant_type":"refresh_token","n":1}'), fields).text).toBe('{"refresh_token":"[redacted sha256:fp2 len:2]","grant_type":"refresh_token","n":1}');
    expect(redactor.body(recordBody('{"messages":[{"content":"hi"}]}'), fields).text).toBe('{"messages":[{"content":"hi"}]}');
    expect(redactor.body(recordBody('{"code":1}'), fields).text).toBe('{"code":1}');
    expect(redactor.body(recordBody("grant_type=authorization_code&code=abc&code_verifier=v%20x"), fields).text).toBe(
      `grant_type=authorization_code&code=${encodeURIComponent("[redacted sha256:fp3 len:3]")}&code_verifier=${encodeURIComponent("[redacted sha256:fp3 len:3]")}`,
    );
    expect(redactor.body(recordBody(`token is ${jwt}`), fields).text).toBe(`token is [redacted sha256:fp${jwt.length} len:${jwt.length}]`);
    const binary = { encoding: "base64", text: "AAEC", bytes: 3 } as const;
    expect(redactor.body(binary, fields)).toBe(binary);
  });

  test("redactEntry: request kinds use the request fields, answers the answer fields; every recorded part", () => {
    const request = redactEntry(
      { kind: "upstream-request", id: "u", url: "https://t/?code=c", headers: [["authorization", "x"]], body: recordBody('{"code":"c"}'), path: "/p", query: { code: "q" }, error: "e", answer: "a" },
      redactor,
    );
    expect(request).toEqual({
      kind: "upstream-request",
      id: "u",
      url: `https://t/?code=${encodeURIComponent("[redacted sha256:fp1 len:1]")}`,
      headers: [["authorization", "[redacted sha256:fp1 len:1]"]],
      body: { encoding: "utf8", text: '{"code":"[redacted sha256:fp1 len:1]"}', bytes: 12 },
      path: "/p",
      query: { code: "[redacted sha256:fp1 len:1]" },
      error: "e",
      answer: "a",
    });
    // An answer's `code` is an error code, not a grant: kept.
    expect(redactEntry({ kind: "upstream-response", id: "u", body: recordBody('{"code":"bad","access_token":"t"}') }, redactor)["body"]).toEqual({
      encoding: "utf8",
      text: '{"code":"bad","access_token":"[redacted sha256:fp1 len:1]"}',
      bytes: 33,
    });
    expect(redactEntry({ kind: "upstream-request", id: "u", decodedBody: '{"refresh_token":"r","n":1}' }, redactor)["decodedBody"]).toBe('{"refresh_token":"[redacted sha256:fp1 len:1]","n":1}');
    expect(redactEntry({ kind: "browser-open", id: "b" }, redactor)).toEqual({ kind: "browser-open", id: "b" });
  });
});
