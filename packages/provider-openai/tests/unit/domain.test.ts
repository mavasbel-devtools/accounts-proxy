// provider-openai domain rules (docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md).
import { describe, expect, test } from "bun:test";
import { InvalidRequestError, UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import { base64UrlEncode } from "@inference-router/core/domain/services/base64url.ts";
import { isSnapshot, parseModelList, STATIC_CATALOG } from "@inference-router/provider-openai/domain/catalog.ts";
import { FALLBACK_MODELS, SCOPES, SHARING_ERROR_STATUS, UNSUPPORTED_FIELDS, UNSUPPORTED_TOOL_TYPES } from "@inference-router/provider-openai/domain/constants.ts";
import { fromAccount, grantedTokens, grantsPlanUsage, refreshed, toAccount, type OpenAITokens } from "@inference-router/provider-openai/domain/credential.ts";
import { checkClaims, IdTokenError, parseCompactJws } from "@inference-router/provider-openai/domain/id-token.ts";
import { aggregate, OutputItems, prepareRequest, StreamRepair } from "@inference-router/provider-openai/domain/responses.ts";

const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));

const tokens: OpenAITokens = { accessToken: "at", refreshToken: "rt", expiresAt: 5, scopes: SCOPES, clientId: "oaiapp_1", subject: "sub-1", idToken: "id.tok.en", email: "me@x" };

describe("credential (S13–S14, T1–T5)", () => {
  test("grantedTokens: expires_in defaults to 3600 s; id_token and scope are optional", () => {
    expect(grantedTokens({ access_token: "a", refresh_token: "r" }, 1000)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 1000 + 3_600_000 });
    expect(grantedTokens({ access_token: "a", refresh_token: "r", expires_in: 60, id_token: "i", scope: "x y" }, 0)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 60_000, idToken: "i", scopes: "x y" });
    expect(grantedTokens({ access_token: "a", refresh_token: "r", expires_in: Number.NaN, scope: 1 }, 0)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 3_600_000 });
    expect(() => grantedTokens({ access_token: "a" }, 0)).toThrow("lacks access_token/refresh_token");
    expect(() => grantedTokens({ refresh_token: "r" }, 0)).toThrow("lacks access_token/refresh_token");
  });

  test("plan usage needs chatgpt.tokens.use.direct", () => {
    expect(grantsPlanUsage(SCOPES)).toBe(true);
    expect(grantsPlanUsage("openid profile email")).toBe(false);
  });

  test("a refresh replaces tokens, expiry and scopes together and keeps the identity", () => {
    expect(refreshed(tokens, { accessToken: "a2", refreshToken: "r2", expiresAt: 9, idToken: "ignored" })).toEqual({ ...tokens, accessToken: "a2", refreshToken: "r2", expiresAt: 9 });
    expect(refreshed(tokens, { accessToken: "a2", refreshToken: "r2", expiresAt: 9, scopes: "s" }).scopes).toBe("s");
  });

  test("account round trip: id = issued client id, label = email else subject", () => {
    const account = toAccount(tokens);
    expect(account).toEqual({ provider: "openai", id: "oaiapp_1", label: "me@x", data: { accessToken: "at", refreshToken: "rt", expiresAt: 5, scopes: SCOPES, clientId: "oaiapp_1", subject: "sub-1", idToken: "id.tok.en", email: "me@x" } });
    expect(fromAccount(account)).toEqual(tokens);
    const { email: _email, ...anonymous } = tokens;
    expect(toAccount(anonymous).label).toBe("sub-1");
    expect(fromAccount(toAccount(anonymous))).toEqual(anonymous);
  });

  test.each([
    [[]],
    [{ accessToken: "a" }],
    [{ accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: "s" }],
    [{ accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: "s", clientId: "c", subject: "s" }],
    [{ accessToken: "a", refreshToken: "r", expiresAt: "1", scopes: "s", clientId: "c", subject: "s", idToken: "i" }],
  ])("a stored shape that is not an OpenAI credential is unreadable: %p", (data) => {
    expect(fromAccount({ provider: "openai", id: "x", label: "x", data: data as never })).toBeUndefined();
  });
});

describe("ID token (S12)", () => {
  const header = enc({ alg: "RS256", kid: "k" });
  const claims = { iss: "https://auth.openai.com", aud: ["oaiapp_1"], exp: 2000, nonce: "n", sub: "s", email: "e@x" };

  test("compact JWS: header, claims, signing input and signature", () => {
    const jws = parseCompactJws(`${header}.${enc(claims)}.${enc("sig")}`);
    expect(jws.header).toEqual({ alg: "RS256", kid: "k" });
    expect(jws.claims).toEqual(claims);
    expect(jws.signingInput).toBe(`${header}.${enc(claims)}`);
    expect(new TextDecoder().decode(jws.signature)).toBe("sig");
  });

  test.each([
    ["a.b", "not a compact JWS (three dot-separated parts)"],
    [`!.${enc({})}.${enc("s")}`, "the header is not a base64url JSON object"],
    [`${enc("[1]")}.${enc({})}.${enc("s")}`, "the header is not a base64url JSON object"],
    [`${enc("{oops")}.${enc({})}.${enc("s")}`, "the header is not a base64url JSON object"],
    [`${header}.${enc("x")}.${enc("s")}`, "the payload is not a base64url JSON object"],
    [`${header}.${enc({})}.`, "the signature is not base64url"],
    [`${header}.${enc({})}.%%`, "the signature is not base64url"],
    [`${enc({ alg: "HS256" })}.${enc({})}.${enc("s")}`, 'algorithm "HS256" is not RS256'],
  ])("malformed token %p", (token, reason) => {
    expect(() => parseCompactJws(token)).toThrow(new IdTokenError(reason));
  });

  test("claims: issuer, audience (string or list), expiry, nonce, subject; the email is optional", () => {
    const expected = { clientId: "oaiapp_1", nonce: "n", now: 1_000_000 };
    expect(checkClaims(claims, expected)).toEqual({ subject: "s", email: "e@x" });
    expect(checkClaims({ ...claims, aud: "oaiapp_1", email: "" }, expected)).toEqual({ subject: "s" });
    const reject = (over: Record<string, unknown>, reason: string) => expect(() => checkClaims({ ...claims, ...over }, expected)).toThrow(new IdTokenError(reason));
    reject({ iss: "https://evil" }, 'issuer "https://evil" is not https://auth.openai.com');
    reject({ aud: ["other"] }, "the audience is not this client");
    reject({ exp: 1000 }, "expired or without exp");
    reject({ exp: "2000" }, "expired or without exp");
    reject({ nonce: "m" }, "the nonce does not match this sign-in attempt");
    reject({ sub: " " }, "the subject is missing");
    reject({ sub: 1 }, "the subject is missing");
  });
});

describe("model list (M1–M2)", () => {
  test("keeps visibility list in server order; display name and context window when present", () => {
    const list = parseModelList({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list", context_window: 500_000 },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-5.5", display_name: "", visibility: "list", context_window: 0 },
        { slug: "", visibility: "list" },
        "junk",
        { slug: "gpt-6-luna", visibility: "list", context_window: 1.5 },
      ],
    });
    expect(list).toEqual([
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 500_000 },
      { id: "gpt-5.5", displayName: "gpt-5.5" },
      { id: "gpt-6-luna", displayName: "gpt-6-luna" },
    ]);
    expect(() => parseModelList({ data: [] })).toThrow("model list has no models array");
    expect(() => parseModelList(null)).toThrow("model list has no models array");
  });

  test("the built-in list is the 16 chatgpt.ts slugs", () => {
    expect(STATIC_CATALOG.map((e) => e.id)).toEqual([...FALLBACK_MODELS]);
    expect(FALLBACK_MODELS).toHaveLength(16);
  });

  test("a stored copy belongs to one registration", () => {
    const snapshot = { version: 1, clientId: "c", fetchedAt: 1, models: [{ id: "m", displayName: "M" }] };
    expect(isSnapshot(snapshot, "c")).toBe(true);
    expect(isSnapshot(snapshot, "d")).toBe(false);
    expect(isSnapshot({ ...snapshot, version: 2 }, "c")).toBe(false);
    expect(isSnapshot({ ...snapshot, fetchedAt: "1" }, "c")).toBe(false);
    expect(isSnapshot({ ...snapshot, models: {} }, "c")).toBe(false);
    expect(isSnapshot({ ...snapshot, models: [{ id: "m" }] }, "c")).toBe(false);
    expect(isSnapshot(undefined, "c")).toBe(false);
  });
});

describe("Responses request (I2–I4, O7)", () => {
  test("store false and stream true are always sent; the client's stream choice is kept apart; nulls are dropped", () => {
    expect(prepareRequest({ model: "x", input: [{ role: "user", content: "hi" }], stream: false, temperature: null }, "gpt-6.1-sol", false)).toEqual({
      body: { model: "gpt-6.1-sol", input: [{ role: "user", content: "hi" }], stream: true, store: false },
      clientStream: false,
      dropped: [],
    });
    expect(prepareRequest({ input: "hi", stream: true, store: false }, "m", false)).toEqual({ body: { input: [{ role: "user", content: "hi" }], stream: true, store: false, model: "m" }, clientStream: true, dropped: [] });
  });

  test("every documented unsupported field, store: true, system items and hosted tools are 400 unsupported_feature", () => {
    const body: Record<string, unknown> = { input: [{ role: "system", content: "s" }, { type: "message", role: "system", content: "s" }, { role: "user", content: "u" }], store: true };
    for (const field of UNSUPPORTED_FIELDS) body[field] = 1;
    body["tools"] = [{ type: "function", name: "f" }, ...UNSUPPORTED_TOOL_TYPES.map((type) => ({ type })), { type: "file_search" }];
    body["tool_choice"] = { type: "file_search" };
    let error: unknown;
    try {
      prepareRequest(body as never, "m", false);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect((error as UnsupportedFeatureError).message).toBe(
      `openai (ChatGPT plan usage) cannot carry: ${[...UNSUPPORTED_FIELDS, "store", "input.system_message", ...UNSUPPORTED_TOOL_TYPES.map((t) => `tools.${t}`), "tool_choice.file_search"].join(", ")}`,
    );
  });

  test("lossy: the unsupported parts are dropped and reported", () => {
    const prepared = prepareRequest(
      { input: [{ role: "system", content: "s" }, { role: "user", content: "u" }], temperature: 0, store: true, tools: [{ type: "function", name: "f" }, { type: "mcp" }], tool_choice: { type: "mcp" } },
      "m",
      true,
    );
    expect(prepared.body).toEqual({ input: [{ role: "user", content: "u" }], store: false, stream: true, tools: [{ type: "function", name: "f" }], model: "m" });
    expect(prepared.dropped).toEqual(["temperature", "store", "input.system_message", "tools.mcp", "tool_choice.mcp"]);
    expect(prepareRequest({ input: [], tools: [{ type: "function" }], tool_choice: "auto" }, "m", false).body).toEqual({ input: [], tools: [{ type: "function" }], tool_choice: "auto", store: false, stream: true, model: "m" });
  });

  test("invalid bodies", () => {
    expect(() => prepareRequest({ input: [], stream: "yes" }, "m", false)).toThrow(new InvalidRequestError("stream must be a boolean"));
    expect(() => prepareRequest({}, "m", false)).toThrow(new InvalidRequestError("input must be a string or an array of input items"));
    expect(() => prepareRequest({ input: 3 }, "m", false)).toThrow(InvalidRequestError);
  });
});

describe("aggregation (O8, E2–E3)", () => {
  const response = { id: "resp_1", object: "response", status: "completed", output: [] };

  test("completed and incomplete responses are the answer", () => {
    expect(aggregate([{ type: "response.created", response: { id: "x" } }, { type: "response.completed", response }])).toEqual({ kind: "response", response });
    expect(aggregate([{ type: "response.incomplete", response: { ...response, status: "incomplete" } }])).toEqual({ kind: "response", response: { ...response, status: "incomplete" } });
    expect(aggregate([{ type: "response.completed" }]).kind).toBe("error");
  });

  test("failures carry the documented status of their code, else 502", () => {
    expect(aggregate([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }])).toEqual({
      kind: "error",
      status: 429,
      body: { error: { message: "limit", type: "response_failed", param: null, code: "subscription_sharing_usage_limit_exceeded" } },
    });
    expect(aggregate([{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }])).toMatchObject({ status: 502 });
    expect(aggregate([{ type: "response.failed" }])).toEqual({ kind: "error", status: 502, body: { error: { message: "the response failed", type: "response_failed", param: null, code: null } } });
    expect(aggregate([{ type: "error", code: "subscription_sharing_unsupported_capability", message: "no", param: "tools" }])).toEqual({
      kind: "error",
      status: 400,
      body: { error: { message: "no", type: "response_failed", param: "tools", code: "subscription_sharing_unsupported_capability" } },
    });
    expect(aggregate([{ type: "error", code: null }])).toMatchObject({ status: 502, body: { error: { message: "the stream reported an error" } } });
    expect(aggregate([])).toEqual({ kind: "error", status: 502, body: { error: { message: "upstream stream ended without response.completed", type: "upstream_error", param: null, code: null } } });
  });

  test("I6: a terminal response without output gets the output_item.done items in output_index order", () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
    const call = { type: "function_call", call_id: "c1", name: "get_time", arguments: "{}" };
    const events = [
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.done", item: { ignored: true } },
      { type: "response.completed", response: { id: "r", output: [] } },
    ];
    expect(aggregate(events)).toEqual({ kind: "response", response: { id: "r", output: [message, call] } });
    expect(aggregate([events[0]!, { type: "response.incomplete", response: { id: "r" } }])).toEqual({ kind: "response", response: { id: "r", output: [call] } });
    const own = { id: "r", output: [message] };
    expect(aggregate([events[0]!, { type: "response.completed", response: own }])).toEqual({ kind: "response", response: own });
    expect(new OutputItems().complete({ id: "r", output: [] })).toEqual({ id: "r", output: [] });
  });

  test("I6: StreamRepair passes frames unchanged, holds a partial frame and fills the terminal response", () => {
    const item = { type: "message", content: [{ type: "output_text", text: "OK" }] };
    const frame = (e: Record<string, unknown>, end = "\n\n") => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}${end}`;
    const done = frame({ type: "response.output_item.done", output_index: 0, item });
    const completed = { type: "response.completed", response: { id: "r", output: [] } };
    const repair = new StreamRepair();
    expect(repair.push(done.slice(0, 20))).toBe("");
    expect(repair.push(`${done.slice(20)}: keep-alive\n\ndata: [DONE]\r\n\r\n`)).toBe(`${done}: keep-alive\n\ndata: [DONE]\r\n\r\n`);
    expect(repair.push(frame(completed))).toBe(frame({ ...completed, response: { id: "r", output: [item] } }));
    expect(repair.terminal).toBe("response.completed");
    expect(repair.flush()).toBe("");
    // A terminal frame without its blank line arrives through flush; one that already has output is unchanged.
    const tail = new StreamRepair();
    expect(tail.push(done)).toBe(done);
    expect(tail.push(frame(completed, ""))).toBe("");
    expect(tail.flush()).toBe(frame({ ...completed, response: { id: "r", output: [item] } }, ""));
    const own = frame({ type: "response.completed", response: { id: "r", output: [item] } });
    expect(new StreamRepair().push(own)).toBe(own);
    const failed = new StreamRepair();
    expect(failed.push(frame({ type: "response.failed", response: { error: {} } }))).toContain("response.failed");
    expect([failed.terminal, failed.push(frame({ type: "response.completed" }))]).toEqual(["response.failed", frame({ type: "response.completed" })]);
    expect(failed.push("data: 1\n\n")).toBe("data: 1\n\n");
    const compact = new StreamRepair();
    compact.push(`data:${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
    expect(compact.push(`data:${JSON.stringify(completed)}\n\n`)).toBe(`data: ${JSON.stringify({ ...completed, response: { id: "r", output: [item] } })}\n\n`);
    expect(Object.keys(SHARING_ERROR_STATUS)).toHaveLength(9);
  });
});
