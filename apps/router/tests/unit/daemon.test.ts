// The daemon's application services, route table and shutdown signal (P4 plan §2.1), against fake ports and the
// real dialect codecs.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  InvalidRequestError,
  PayloadTooLargeError,
  ProviderDisabledError,
  QuotaExhaustedError,
  UnknownModelError,
  UnsupportedFeatureError,
} from "@inference-router/core/domain/errors.ts";
import type { Dialect, ModelCatalog, ProviderId } from "@inference-router/core/domain/models.ts";
import { bodyOf, readAll, type HttpResponse, type RawRequest } from "@inference-router/core/domain/wire.ts";
import { AccessPort } from "@inference-router/core/ports/inbound/access.ts";
import { HealthPort, ListModelsPort, PassthroughPort } from "@inference-router/core/ports/inbound/routing.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import { RouterTokenStorePort } from "@inference-router/core/ports/outbound/router-token.ts";
import { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { AnthropicCodec } from "@inference-router/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@inference-router/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@inference-router/dialect-openai/adapters/inbound/openai-codec.ts";
import { MemoryLogger, ScriptedTransport, SequenceRandom } from "@inference-router/test-support/fakes.ts";
import type { InboundRequest } from "@inference-router/router/adapters/inbound/http/http-handler.ts";
import { geminiModelRoute, presentedToken, RouteHandler } from "@inference-router/router/adapters/inbound/http/route-handler.ts";
import { ProcessShutdownSignal, SHUTDOWN_SIGNALS } from "@inference-router/router/adapters/inbound/process-shutdown-signal.ts";
import { AccessService, TOKEN_BYTES } from "@inference-router/router/application/access-service.ts";
import { DaemonStatusService, STATUS_TIMEOUT_MS } from "@inference-router/router/application/daemon-status-service.ts";
import { LoggingErrorReporter } from "@inference-router/router/application/error-reporter.ts";
import { HealthService, PassthroughService } from "@inference-router/router/application/passthrough-service.ts";

class Provider extends ProviderPort {
  calls: [string, RawRequest][] = [];
  constructor(
    readonly id: ProviderId,
    readonly nativeDialect: Dialect,
  ) {
    super();
  }
  capabilities() {
    return new Set<never>();
  }
  async models(): Promise<ModelCatalog> {
    return { provider: this.id, nativeDialect: this.nativeDialect, source: "live", models: [] };
  }
  async *stream() {}
  async countTokens() {
    return 0;
  }
  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    this.calls.push([model, request]);
    return { status: 200, headers: {}, body: bodyOf("ok") };
  }
}

const raw: RawRequest = { path: "/v1/messages", query: {}, headers: {}, body: "{}", lossy: false };

describe("PassthroughService and HealthService", () => {
  test("resolves addresses and aliases to the provider's native cell", async () => {
    const claude = new Provider("claude", "anthropic");
    const service = new PassthroughService([claude, new Provider("antigravity", "gemini")], { fast: "claude/claude-haiku-4-5-20251001" });
    await service.forward("anthropic", "claude/claude-opus-5", raw);
    await service.forward("anthropic", "fast", raw);
    expect(claude.calls.map(([m]) => m)).toEqual(["claude-opus-5", "claude-haiku-4-5-20251001"]);
  });

  test("unknown model, disabled provider, and a translated cell (P5) are errors", async () => {
    const service = new PassthroughService([new Provider("antigravity", "gemini")], {});
    expect(() => service.forward("anthropic", "nope", raw)).toThrow(UnknownModelError);
    expect(() => service.forward("anthropic", "claude/x", raw)).toThrow(ProviderDisabledError);
    expect(() => service.forward("anthropic", "antigravity/g", raw)).toThrow("antigravity (it speaks gemini; translated cells arrive in P5)");
  });

  test("health lists the enabled providers", () => {
    expect(new HealthService(["claude"]).enabledProviders()).toEqual(["claude"]);
  });
});

class MemoryTokenStore extends RouterTokenStorePort {
  reads = 0;
  constructor(public value: string | undefined) {
    super();
  }
  async read() {
    this.reads += 1;
    return this.value;
  }
  async write(token: string) {
    this.value = token;
  }
}
class TextHash extends HashPort {
  sha256(input: string) {
    return new TextEncoder().encode(input.padEnd(64, "\0"));
  }
}

describe("AccessService", () => {
  test("creates a 32-byte base64url token once, then reuses it; authorize compares digests", async () => {
    const store = new MemoryTokenStore(undefined);
    const access = new AccessService(store, new SequenceRandom(), new TextHash());
    const token = await access.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(TOKEN_BYTES).toBe(32);
    expect(store.value).toBe(token);
    expect(await access.token()).toBe(token);
    expect(store.reads).toBe(1);
    expect(await access.authorize(token)).toBe(true);
    expect(await access.authorize(`${token}x`)).toBe(false);
    expect(await access.authorize(undefined)).toBe(false);
  });

  test("a stored token is used as is", async () => {
    expect(await new AccessService(new MemoryTokenStore("stored"), new SequenceRandom(), new TextHash()).token()).toBe("stored");
  });
});

describe("DaemonStatusService", () => {
  const status = (handler: ConstructorParameters<typeof ScriptedTransport>[0]) => {
    const transport = new ScriptedTransport(handler);
    return { transport, service: new DaemonStatusService(transport, "http://127.0.0.1:4141") };
  };

  test("a health answer is running (unknown provider names ignored); the probe is a short GET /health", async () => {
    const { service, transport } = status(() => ({ status: 200, body: '{"status":"ok","providers":["claude","nope",3]}' }));
    expect(await service.status()).toEqual({ running: true, url: "http://127.0.0.1:4141", providers: ["claude"] });
    expect(transport.requests[0]).toEqual({ method: "GET", url: "http://127.0.0.1:4141/health", headers: {}, timeoutMs: STATUS_TIMEOUT_MS });
  });

  test.each([
    [{ status: 503, body: "" }, "GET /health answered HTTP 503"],
    [{ status: 200, body: '{"status":"down","providers":[]}' }, "not an inference-router health answer"],
    [{ status: 200, body: '{"status":"ok"}' }, "not an inference-router health answer"],
    [{ status: 200, body: "<html>" }, "JSON"],
  ])("%p is not running", async (response, reason) => {
    const result = await status(() => response).service.status();
    expect(result.running).toBe(false);
    expect(result.running === false && result.reason).toContain(reason);
  });

  test("a refused connection is not running, with the reason", async () => {
    expect(await status(() => Promise.reject(new Error("Unable to connect"))).service.status()).toEqual({ running: false, url: "http://127.0.0.1:4141", reason: "Unable to connect" });
  });
});

describe("ProcessShutdownSignal", () => {
  test("resolves with the first signal and removes every listener", async () => {
    const source = new EventEmitter();
    const waiting = new ProcessShutdownSignal(source).wait();
    expect(SHUTDOWN_SIGNALS.map((s) => source.listenerCount(s))).toEqual([1, 1]);
    source.emit("SIGTERM");
    expect(await waiting).toBe("SIGTERM");
    expect(SHUTDOWN_SIGNALS.map((s) => source.listenerCount(s))).toEqual([0, 0]);
    const second = new ProcessShutdownSignal(source).wait();
    source.emit("SIGINT");
    expect(await second).toBe("SIGINT");
  });

  test("defaults to the process", () => {
    expect(new ProcessShutdownSignal()).toBeInstanceOf(ProcessShutdownSignal);
  });
});

describe("presentedToken and geminiModelRoute", () => {
  test("token carriers in order: Bearer (any case), x-api-key, x-goog-api-key, ?key=", () => {
    expect(presentedToken({ authorization: "bearer  T1 " }, {})).toBe("T1");
    expect(presentedToken({ authorization: "Basic x", "x-api-key": "T2" }, {})).toBe("T2");
    expect(presentedToken({ "x-goog-api-key": "T3" }, { key: "T4" })).toBe("T3");
    expect(presentedToken({}, { key: "T4" })).toBe("T4");
    expect(presentedToken({}, {})).toBeUndefined();
  });

  test("model segment encoded or raw, up to the last colon; malformed encodings are invalid", () => {
    expect(geminiModelRoute("/v1beta/models/antigravity%2Fgemini-3.6-flash-low:streamGenerateContent")).toEqual({ model: "antigravity/gemini-3.6-flash-low", method: "streamGenerateContent" });
    expect(geminiModelRoute("/v1beta/models/antigravity/gemini:x:generateContent")).toEqual({ model: "antigravity/gemini:x", method: "generateContent" });
    expect(geminiModelRoute("/v1beta/models/g")).toBeUndefined();
    expect(() => geminiModelRoute("/v1beta/models/%E0%A4%A:generateContent")).toThrow(InvalidRequestError);
  });
});

class Access extends AccessPort {
  async token() {
    return "T";
  }
  async authorize(candidate: string | undefined) {
    return candidate === "T";
  }
}
class Passthrough extends PassthroughPort {
  calls: [Dialect, string, RawRequest][] = [];
  next: () => Promise<HttpResponse> = async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: bodyOf("data: x\n\n") });
  forward(dialect: Dialect, model: string, request: RawRequest) {
    this.calls.push([dialect, model, request]);
    return this.next();
  }
}
class Models extends ListModelsPort {
  async listModels(): Promise<readonly ModelCatalog[]> {
    return [
      { provider: "claude", nativeDialect: "anthropic", source: "cache", models: [{ address: { provider: "claude", model: "c" }, displayName: "C" }] },
      { provider: "antigravity", nativeDialect: "gemini", source: "live", models: [] },
    ];
  }
}
class Health extends HealthPort {
  enabledProviders(): readonly ProviderId[] {
    return ["claude", "antigravity"];
  }
}

describe("RouteHandler", () => {
  const make = () => {
    const passthrough = new Passthrough();
    const logger = new MemoryLogger();
    const errors = new LoggingErrorReporter(logger);
    const handler = new RouteHandler([new AnthropicCodec(), new OpenAiCodec(), new GeminiCodec()], { access: new Access(), passthrough, models: new Models(), health: new Health() }, errors);
    return { handler, passthrough, logger };
  };
  const request = (method: string, path: string, over: Partial<InboundRequest> = {}): InboundRequest => ({
    method,
    path,
    query: {},
    headers: { authorization: "Bearer T" },
    readBody: async () => '{"model":"claude/claude-opus-5","messages":[]}',
    signal: new AbortController().signal,
    ...over,
  });
  const json = async (response: { status: number; body: AsyncIterable<Uint8Array> }) => ({ status: response.status, body: JSON.parse(await readAll(response.body)) as unknown });

  test("GET /health is open; a path outside every dialect is a plain JSON 404", async () => {
    const { handler } = make();
    expect(await json(await handler.handle(request("GET", "/health", { headers: {} })))).toEqual({ status: 200, body: { status: "ok", providers: ["claude", "antigravity"] } });
    expect(await json(await handler.handle(request("POST", "/health", { headers: {} })))).toEqual({ status: 404, body: { error: { code: "not_found", message: "no route POST /health" } } });
    expect((await handler.handle(request("GET", "/anthropicx/v1/models"))).status).toBe(404);
  });

  test("every other route needs the router token; the 401 is in the route's dialect", async () => {
    const { handler } = make();
    const anthropic = await json(await handler.handle(request("GET", "/anthropic/v1/models", { headers: {} })));
    expect(anthropic).toEqual({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "missing or invalid inference-router token" } } });
    const gemini = await json(await handler.handle(request("GET", "/gemini/v1beta/models", { headers: { "x-goog-api-key": "wrong" } })));
    expect(gemini.status).toBe(401);
    expect((gemini.body as { error: { status: string } }).error.status).toBe("UNAUTHENTICATED");
    expect((await handler.handle(request("GET", "/gemini/v1beta/models", { headers: {}, query: { key: "T" } }))).status).toBe(200);
    expect((await handler.handle(request("GET", "/openai/v1/models", { headers: { "x-api-key": "T" } }))).status).toBe(200);
  });

  test("model lists in each dialect, with x-router-models-source", async () => {
    const { handler } = make();
    for (const [path, key] of [
      ["/anthropic/v1/models", "data"],
      ["/openai/v1/models", "data"],
      ["/gemini/v1beta/models", "models"],
    ] as const) {
      const response = await handler.handle(request("GET", path));
      expect(response.status).toBe(200);
      expect(response.headers["x-router-models-source"]).toBe("claude=cache,antigravity=live");
      expect(Object.keys(JSON.parse(await readAll(response.body)) as object)).toContain(key);
    }
  });

  test("Anthropic messages and count_tokens: model from the body, token key removed from the query, lossy flag, signal", async () => {
    const { handler, passthrough } = make();
    const controller = new AbortController();
    const response = await handler.handle(request("POST", "/anthropic/v1/messages", { query: { key: "T", beta: "true" }, headers: { "x-api-key": "T", "x-router-lossy": "1" }, signal: controller.signal }));
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(await readAll(response.body)).toBe("data: x\n\n");
    await handler.handle(request("POST", "/anthropic/v1/messages/count_tokens"));
    const [[dialect, model, raw], [, , count]] = passthrough.calls as [[Dialect, string, RawRequest], [Dialect, string, RawRequest]];
    expect([dialect, model, raw.path, raw.query, raw.lossy, raw.signal]).toEqual(["anthropic", "claude/claude-opus-5", "/v1/messages", { beta: "true" }, true, controller.signal]);
    expect(raw.body).toBe('{"model":"claude/claude-opus-5","messages":[]}');
    expect([count.path, count.lossy]).toEqual(["/v1/messages/count_tokens", false]);
  });

  test.each([
    ["{oops", "request body is not valid JSON"],
    ['{"messages":[]}', "request body needs a string model"],
    ["[1]", "request body needs a string model"],
  ])("Anthropic body %p → 400 %p", async (body, message) => {
    const { handler, passthrough } = make();
    const result = await json(await handler.handle(request("POST", "/anthropic/v1/messages", { readBody: async () => body })));
    expect(result.status).toBe(400);
    expect((result.body as { error: { message: string } }).error.message).toContain(message);
    expect(passthrough.calls).toHaveLength(0);
  });

  test("OpenAI chat completions is a translated cell: 400 unsupported_feature in the OpenAI shape", async () => {
    const { handler } = make();
    const result = await json(await handler.handle(request("POST", "/openai/v1/chat/completions")));
    expect(result).toEqual({ status: 400, body: { error: { message: "openai dialect (both OpenAI cells are translated: P5) cannot carry: chat_completions", type: "unsupported_feature", param: null, code: "unsupported_feature" } } });
  });

  test("Gemini model routes: decoded model, dialect-relative path; a malformed segment is a Gemini 400", async () => {
    const { handler, passthrough } = make();
    await handler.handle(request("POST", "/gemini/v1beta/models/antigravity%2Fg:streamGenerateContent", { query: { alt: "sse", key: "T" }, headers: {} }));
    expect(passthrough.calls[0]!.slice(0, 2)).toEqual(["gemini", "antigravity/g"]);
    expect([passthrough.calls[0]![2].path, passthrough.calls[0]![2].query]).toEqual(["/v1beta/models/antigravity%2Fg:streamGenerateContent", { alt: "sse" }]);
    const bad = await json(await handler.handle(request("POST", "/gemini/v1beta/models/%E0%A4%A:generateContent")));
    expect((bad.body as { error: { status: string } }).error.status).toBe("INVALID_ARGUMENT");
  });

  test("unknown routes under a prefix are a 404 in that dialect", async () => {
    const { handler } = make();
    for (const [method, path] of [
      ["GET", "/anthropic"],
      ["GET", "/anthropic/v1/messages"],
      ["DELETE", "/openai/v1/models"],
      ["GET", "/gemini/v1beta/models/antigravity/g:generateContent"],
      ["POST", "/gemini/v1/models"],
    ]) {
      expect((await handler.handle(request(method!, path!))).status).toBe(404);
    }
  });

  test("router errors are rendered by the dialect (status, retry-after); anything else is a logged 500", async () => {
    const { handler, passthrough, logger } = make();
    passthrough.next = () => Promise.reject(new QuotaExhaustedError("claude", "slow down", 9));
    const quota = await handler.handle(request("POST", "/anthropic/v1/messages"));
    expect([quota.status, quota.headers["retry-after"]]).toEqual([429, "9"]);
    passthrough.next = () => Promise.reject(new UnsupportedFeatureError(["x"], "y"));
    expect((await handler.handle(request("POST", "/anthropic/v1/messages"))).status).toBe(400);
    passthrough.next = () => Promise.reject(new TypeError("boom"));
    const internal = await json(await handler.handle(request("POST", "/gemini/v1beta/models/antigravity%2Fg:generateContent")));
    expect(internal).toEqual({ status: 500, body: { error: { code: 500, message: "internal router error (details are in the router log)", status: "INTERNAL" } } });
    expect(logger.lines).toEqual(["ERROR POST /gemini/v1beta/models/antigravity%2Fg:generateContent failed TypeError: boom"]);
  });

  test("a body past the limit is a 413 in the dialect", async () => {
    const { handler } = make();
    const result = await json(await handler.handle(request("POST", "/anthropic/v1/messages", { readBody: () => Promise.reject(new PayloadTooLargeError(10)) })));
    expect(result).toEqual({ status: 413, body: { type: "error", error: { type: "request_too_large", message: "request body exceeds 10 bytes" } } });
  });
});
