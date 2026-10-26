// The daemon's application services, route table and shutdown signal (P4 plan §2.1), against fake ports and the
// real dialect codecs.
import { UpstreamUnreachableError } from "@accounts-proxy/core/domain/errors.ts";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  InvalidRequestError,
  PayloadTooLargeError,
  ProviderDisabledError,
  QuotaExhaustedError,
  UnknownModelError,
  UnsupportedFeatureError,
} from "@accounts-proxy/core/domain/errors.ts";
import type { ModelCatalog, ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { bodyOf, readAll, type HttpResponse, type RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import { DescribeModelsPort, HealthPort, PassthroughPort, RefreshModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { describeCatalog, type DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import { OpencodeConfigCodec } from "@accounts-proxy/dialect-opencode/adapters/inbound/opencode-config-codec.ts";
import { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import { ProxyTokenStorePort } from "@accounts-proxy/core/ports/outbound/proxy-token.ts";
import { HashPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { AnthropicCodec } from "@accounts-proxy/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@accounts-proxy/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@accounts-proxy/dialect-openai/adapters/inbound/openai-codec.ts";
import { MemoryLogger, ScriptedTransport, SequenceRandom } from "@accounts-proxy/test-support/fakes.ts";
import type { InboundRequest } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import { geminiModelRoute, presentedToken, RouteHandler } from "@accounts-proxy/proxy/adapters/inbound/http/route-handler.ts";
import { ProcessShutdownSignal, SHUTDOWN_SIGNALS } from "@accounts-proxy/proxy/adapters/inbound/process-shutdown-signal.ts";
import { AccessService, TOKEN_BYTES } from "@accounts-proxy/proxy/application/access-service.ts";
import { DaemonStatusService, STATUS_TIMEOUT_MS } from "@accounts-proxy/proxy/application/daemon-status-service.ts";
import { LoggingErrorReporter } from "@accounts-proxy/proxy/application/error-reporter.ts";
import { HealthService, PassthroughService } from "@accounts-proxy/proxy/application/passthrough-service.ts";

class Provider extends ProviderPort {
  calls: [string, RawRequest][] = [];
  constructor(
    readonly id: ProviderId,
    /** Native formats of every model; undefined: the provider does not know them (forwarded as sent). */
    readonly formats: readonly WireFormat[] | undefined,
  ) {
    super();
  }
  async nativeFormats() {
    return this.formats === undefined ? undefined : new Set(this.formats);
  }
  capabilities() {
    return new Set<never>();
  }
  async models(): Promise<ModelCatalog> {
    return { provider: this.id, formats: this.formats ?? [], source: "live", models: [] };
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

const raw: RawRequest = { format: "anthropic-messages", path: "/v1/messages", query: {}, headers: {}, body: "{}", lossy: false };

describe("PassthroughService and HealthService", () => {
  test("resolves addresses and aliases to the provider's native cell", async () => {
    const claude = new Provider("claude", ["anthropic-messages"]);
    const service = new PassthroughService([claude, new Provider("antigravity", ["gemini"])], { fast: "claude/claude-haiku-4-5-20251001" });
    await service.forward("anthropic-messages", "claude/claude-opus-5", raw);
    await service.forward("anthropic-messages", "fast", raw);
    expect(claude.calls.map(([m]) => m)).toEqual(["claude-opus-5", "claude-haiku-4-5-20251001"]);
  });

  test("a model whose formats the provider does not know is forwarded as sent (plan P4.6 rule Z6)", async () => {
    const gateway = new Provider("opencode-go", undefined);
    await new PassthroughService([gateway], {}).forward("openai-chat", "opencode-go/new-model", { ...raw, format: "openai-chat" });
    expect(gateway.calls.map(([m]) => m)).toEqual(["new-model"]);
  });

  test("unknown model, disabled provider, and a translated cell (P5) are errors", async () => {
    const service = new PassthroughService([new Provider("antigravity", ["gemini"])], {});
    expect(service.forward("anthropic-messages", "nope", raw)).rejects.toBeInstanceOf(UnknownModelError);
    expect(service.forward("anthropic-messages", "claude/x", raw)).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(service.forward("anthropic-messages", "antigravity/g", raw)).rejects.toThrow("antigravity/g (it accepts gemini; the proxy does not translate between formats) cannot carry: anthropic-messages_format");
  });

  test("health lists the enabled providers", () => {
    expect(new HealthService(["claude"]).enabledProviders()).toEqual(["claude"]);
  });
});

class MemoryTokenStore extends ProxyTokenStorePort {
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
    [{ status: 200, body: '{"status":"down","providers":[]}' }, "not an accounts-proxy health answer"],
    [{ status: 200, body: '{"status":"ok"}' }, "not an accounts-proxy health answer"],
    [{ status: 200, body: "<html>" }, "JSON"],
  ])("%p is not running", async (response, reason) => {
    const result = await status(() => response).service.status();
    expect(result.running).toBe(false);
    expect(result.running === false && result.reason).toContain(reason);
  });

  test("a refused connection is not running, with the reason", async () => {
    expect(await status(() => Promise.reject(new Error("Unable to connect"))).service.status()).toEqual({ running: false, url: "http://127.0.0.1:4141", reason: "Unable to connect" });
    const refused = await status(() => Promise.reject(new UpstreamUnreachableError("127.0.0.1:4141", "TypeError: Unable to connect"))).service.status();
    expect(refused).toEqual({ running: false, url: "http://127.0.0.1:4141", reason: "nothing is listening: TypeError: Unable to connect" });
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
  calls: [WireFormat, string, RawRequest][] = [];
  next: () => Promise<HttpResponse> = async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: bodyOf("data: x\n\n") });
  forward(format: WireFormat, model: string, request: RawRequest) {
    this.calls.push([format, model, request]);
    return this.next();
  }
}
class Models extends DescribeModelsPort {
  seen: (ProviderId | undefined)[] = [];
  failure: Error | undefined;
  async describeModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]> {
    this.seen.push(provider);
    if (this.failure !== undefined) throw this.failure;
    const catalogs: ModelCatalog[] = [
      { provider: "claude", formats: ["anthropic-messages"], source: "cache", models: [{ address: { provider: "claude", model: "c" }, displayName: "C" }] },
      { provider: "antigravity", formats: ["gemini"], source: "live", models: [] },
    ];
    return catalogs.map((c) => describeCatalog(c, undefined, undefined));
  }
}
class Refresh extends RefreshModelsPort {
  seen: (ProviderId | undefined)[] = [];
  async refreshModels(provider?: ProviderId): Promise<readonly DetailedCatalog[]> {
    this.seen.push(provider);
    return [describeCatalog({ provider: "claude", formats: ["anthropic-messages"], source: "live", models: [] }, undefined, undefined)];
  }
}
class Health extends HealthPort {
  enabledProviders(): readonly ProviderId[] {
    return ["claude", "antigravity"];
  }
}

const ORIGIN = { origin: "http://127.0.0.1:4141", tokenCommand: ["ir", "token"] };

describe("RouteHandler", () => {
  const make = () => {
    const passthrough = new Passthrough();
    const models = new Models();
    const refresh = new Refresh();
    const logger = new MemoryLogger();
    const errors = new LoggingErrorReporter(logger);
    const handler = new RouteHandler([new AnthropicCodec(), new OpenAiCodec(), new GeminiCodec()], { access: new Access(), passthrough, health: new Health(), describe: models, refresh, opencode: new OpencodeConfigCodec(), origin: ORIGIN }, errors);
    return { handler, passthrough, logger, models, refresh };
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

  test("every other route needs the proxy token; the 401 is in the route's dialect", async () => {
    const { handler } = make();
    const anthropic = await json(await handler.handle(request("GET", "/anthropic/v1/models", { headers: {} })));
    expect(anthropic).toEqual({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "missing or invalid accounts-proxy token" } } });
    const gemini = await json(await handler.handle(request("GET", "/gemini/v1beta/models", { headers: { "x-goog-api-key": "wrong" } })));
    expect(gemini.status).toBe(401);
    expect((gemini.body as { error: { status: string } }).error.status).toBe("UNAUTHENTICATED");
    expect((await handler.handle(request("GET", "/gemini/v1beta/models", { headers: {}, query: { key: "T" } }))).status).toBe(200);
    expect((await handler.handle(request("GET", "/openai/v1/models", { headers: { "x-api-key": "T" } }))).status).toBe(200);
  });

  test("GET /.well-known/opencode is open: the token command and the configuration URL (rules O1, O5)", async () => {
    const { handler } = make();
    expect(await json(await handler.handle(request("GET", "/.well-known/opencode", { headers: {} })))).toEqual({
      status: 200,
      body: { auth: { command: ["ir", "token"], env: "ACCOUNTS_PROXY_TOKEN" }, remote_config: { url: "http://127.0.0.1:4141/opencode/config.json", headers: { authorization: "Bearer {env:ACCOUNTS_PROXY_TOKEN}" } } },
    });
    expect((await handler.handle(request("POST", "/.well-known/opencode", { headers: {} }))).status).toBe(404);
  });

  test("the proxy's own routes: token first, GET only, plain JSON errors; ?provider names one provider", async () => {
    const { handler, models, logger } = make();
    const config = await json(await handler.handle(request("GET", "/opencode/config.json")));
    expect(config.status).toBe(200);
    expect(Object.keys((config.body as { providers: object }).providers)).toEqual(["ap-claude", "ap-antigravity"]);
    const detailed = await json(await handler.handle(request("GET", "/proxy/v1/models", { query: { provider: "claude" } })));
    expect((detailed.body as { catalogs: { provider: string }[] }).catalogs[0]!.provider).toBe("claude");
    expect(models.seen).toEqual([undefined, "claude"]);
    expect(await json(await handler.handle(request("GET", "/proxy/v1/models", { headers: {} })))).toEqual({ status: 401, body: { error: { code: "unauthorized", message: "missing or invalid accounts-proxy token" } } });
    expect(await json(await handler.handle(request("POST", "/opencode/config.json")))).toEqual({ status: 404, body: { error: { code: "not_found", message: "no route POST /opencode/config.json" } } });
    expect((await json(await handler.handle(request("GET", "/proxy/v1/models", { query: { provider: "nope" } })))).body).toEqual({ error: { code: "invalid_request", message: 'unknown provider "nope"' } });
    models.failure = new TypeError("boom");
    expect((await handler.handle(request("GET", "/proxy/v1/models"))).status).toBe(500);
    expect(logger.lines).toEqual(["ERROR GET /proxy/v1/models failed TypeError: boom"]);
    const aborted = new AbortController();
    aborted.abort();
    expect((await handler.handle(request("GET", "/proxy/v1/models", { signal: aborted.signal }))).status).toBe(500);
    expect(logger.lines).toHaveLength(1);
  });

  test("POST /proxy/v1/models/refresh: token first, POST only, ?provider names one provider", async () => {
    const { handler, models, refresh } = make();
    const all = await json(await handler.handle(request("POST", "/proxy/v1/models/refresh")));
    expect(all).toEqual({ status: 200, body: { catalogs: [{ provider: "claude", source: "live", models: [] }] } });
    expect((await handler.handle(request("POST", "/proxy/v1/models/refresh", { query: { provider: "claude" } }))).status).toBe(200);
    expect(refresh.seen).toEqual([undefined, "claude"]);
    expect((await json(await handler.handle(request("POST", "/proxy/v1/models/refresh", { headers: {} })))).status).toBe(401);
    expect(await json(await handler.handle(request("GET", "/proxy/v1/models/refresh")))).toEqual({ status: 404, body: { error: { code: "not_found", message: "no route GET /proxy/v1/models/refresh" } } });
    expect(await json(await handler.handle(request("POST", "/proxy/v1/models")))).toEqual({ status: 404, body: { error: { code: "not_found", message: "no route POST /proxy/v1/models" } } });
    expect((await json(await handler.handle(request("POST", "/proxy/v1/models/refresh", { query: { provider: "nope" } })))).status).toBe(400);
    expect([refresh.seen.length, models.seen]).toEqual([2, []]);
  });

  test("model lists in each dialect, with x-proxy-models-source", async () => {
    const { handler } = make();
    for (const [path, key] of [
      ["/anthropic/v1/models", "data"],
      ["/openai/v1/models", "data"],
      ["/gemini/v1beta/models", "models"],
    ] as const) {
      const response = await handler.handle(request("GET", path));
      expect(response.status).toBe(200);
      expect(response.headers["x-proxy-models-source"]).toBe("claude=cache,antigravity=live");
      expect(Object.keys(JSON.parse(await readAll(response.body)) as object)).toContain(key);
    }
  });

  test("Anthropic messages and count_tokens: model from the body, token key removed from the query, lossy flag, signal", async () => {
    const { handler, passthrough } = make();
    const controller = new AbortController();
    const response = await handler.handle(request("POST", "/anthropic/v1/messages", { query: { key: "T", beta: "true" }, headers: { "x-api-key": "T", "x-proxy-lossy": "1" }, signal: controller.signal }));
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(await readAll(response.body)).toBe("data: x\n\n");
    await handler.handle(request("POST", "/anthropic/v1/messages/count_tokens"));
    const [[format, model, raw], [, , count]] = passthrough.calls as [[WireFormat, string, RawRequest], [WireFormat, string, RawRequest]];
    expect([format, model, raw.format, raw.path, raw.query, raw.lossy, raw.signal]).toEqual(["anthropic-messages", "claude/claude-opus-5", "anthropic-messages", "/v1/messages", { beta: "true" }, true, controller.signal]);
    expect(raw.body).toBe('{"model":"claude/claude-opus-5","messages":[]}');
    expect([count.format, count.path, count.lossy]).toEqual(["anthropic-messages", "/v1/messages/count_tokens", false]);
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

  test("OpenAI Responses and Chat Completions: model from the body, dialect-relative path, the route's format", async () => {
    const { handler, passthrough } = make();
    await handler.handle(request("POST", "/openai/v1/responses", { readBody: async () => '{"model":"openai/gpt-6.1-sol","input":"hi"}' }));
    await handler.handle(request("POST", "/openai/v1/chat/completions", { readBody: async () => '{"model":"openrouter/openai/gpt-5","messages":[]}' }));
    const [[format, model, raw], [chatFormat, chatModel, chat]] = passthrough.calls as [[WireFormat, string, RawRequest], [WireFormat, string, RawRequest]];
    expect([format, model, raw.format, raw.path, raw.body]).toEqual(["openai-responses", "openai/gpt-6.1-sol", "openai-responses", "/v1/responses", '{"model":"openai/gpt-6.1-sol","input":"hi"}']);
    expect([chatFormat, chatModel, chat.format, chat.path]).toEqual(["openai-chat", "openrouter/openai/gpt-5", "openai-chat", "/v1/chat/completions"]);
    const missing = await json(await handler.handle(request("POST", "/openai/v1/responses", { readBody: async () => '{"input":"hi"}' })));
    expect([missing.status, (missing.body as { error: { message: string } }).error.message]).toEqual([400, "request body needs a string model (<provider>/<model> or an alias)"]);
  });

  test("Gemini model routes: decoded model, dialect-relative path; a malformed segment is a Gemini 400", async () => {
    const { handler, passthrough } = make();
    await handler.handle(request("POST", "/gemini/v1beta/models/antigravity%2Fg:streamGenerateContent", { query: { alt: "sse", key: "T" }, headers: {} }));
    expect(passthrough.calls[0]!.slice(0, 2)).toEqual(["gemini", "antigravity/g"]);
    expect(passthrough.calls[0]![2].format).toBe("gemini");
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

  test("proxy errors are rendered by the dialect (status, retry-after); anything else is a logged 500", async () => {
    const { handler, passthrough, logger } = make();
    passthrough.next = () => Promise.reject(new QuotaExhaustedError("claude", "slow down", 9));
    const quota = await handler.handle(request("POST", "/anthropic/v1/messages"));
    expect([quota.status, quota.headers["retry-after"]]).toEqual([429, "9"]);
    passthrough.next = () => Promise.reject(new UnsupportedFeatureError(["x"], "y"));
    expect((await handler.handle(request("POST", "/anthropic/v1/messages"))).status).toBe(400);
    passthrough.next = () => Promise.reject(new TypeError("boom"));
    const internal = await json(await handler.handle(request("POST", "/gemini/v1beta/models/antigravity%2Fg:generateContent")));
    expect(internal).toEqual({ status: 500, body: { error: { code: 500, message: "internal proxy error (details are in the proxy log)", status: "INTERNAL" } } });
    expect(logger.lines).toEqual(["ERROR POST /gemini/v1beta/models/antigravity%2Fg:generateContent failed TypeError: boom"]);
  });

  test("a request the client abandoned is not reported as a proxy failure", async () => {
    const { handler, passthrough, logger } = make();
    const controller = new AbortController();
    controller.abort();
    passthrough.next = () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    expect((await handler.handle(request("POST", "/anthropic/v1/messages", { signal: controller.signal }))).status).toBe(500);
    expect(logger.lines).toEqual([]);
  });

  test("a body past the limit is a 413 in the dialect", async () => {
    const { handler } = make();
    const result = await json(await handler.handle(request("POST", "/anthropic/v1/messages", { readBody: () => Promise.reject(new PayloadTooLargeError(10)) })));
    expect(result).toEqual({ status: 413, body: { type: "error", error: { type: "request_too_large", message: "request body exceeds 10 bytes" } } });
  });
});
