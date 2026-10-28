// The daemon black-box: `serve` in its own process, signed in to both providers (browser logins through the fake
// `xdg-open`), driven by the official SDKs (@anthropic-ai/sdk 0.133.0, @google/genai 2.28.0, openai 7.32.0) and by raw
// HTTP for the byte framing; every upstream exchange is answered by the replay server from committed captures.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI, Type, type Content } from "@google/genai";
import OpenAI from "openai";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { makeHome, runProxy, startDaemon, type Daemon, type Home } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(60_000);

const upstreams = new ReplayUpstreams();
let home: Home;
let daemon: Daemon;
let token: string;
const GEMINI = "antigravity/gemini-3.6-flash-low";
const HAIKU = "claude/claude-haiku-4-5-20251001";

beforeAll(async () => {
  upstreams.start();
  home = await makeHome();
  for (const provider of ["antigravity", "claude"]) {
    const login = await runProxy(home, ["login", provider, "--timeout-seconds", "30"], upstreams.seamEnv());
    if (login.code !== 0) throw new Error(login.stderr);
  }
  token = (await runProxy(home, ["token"], upstreams.seamEnv())).stdout.trim();
  daemon = await startDaemon(home, upstreams.seamEnv());
});

afterAll(async () => {
  await daemon?.stop();
  upstreams.stop();
  removeTemporary(home.dir);
});

const anthropic = () => new Anthropic({ apiKey: token, baseURL: `${daemon.url}/anthropic`, maxRetries: 0 });
const genai = () => new GoogleGenAI({ apiKey: token, httpOptions: { baseUrl: `${daemon.url}/gemini` } });
const openai = () => new OpenAI({ apiKey: token, baseURL: `${daemon.url}/openai/v1`, maxRetries: 0 });
const lastUpstream = (path: string) => upstreams.find(path).at(-1)!;
/** The SDKs return their own thenables (APIPromise/PagePromise); this settles one into the error it failed with. */
const failure = (pending: PromiseLike<unknown>): Promise<unknown> => Promise.resolve(pending).then(() => undefined, (error: unknown) => error);

describe("daemon: health, status, auth", () => {
  test("GET /health is open; status sees the daemon; a wrong token is a 401 in each dialect", async () => {
    expect(await (await fetch(`${daemon.url}/health`)).json()).toEqual({ status: "ok", providers: ["claude", "antigravity"] });
    const status = await runProxy(home, ["status"], upstreams.seamEnv());
    expect([status.code, status.stdout]).toEqual([0, `running at ${daemon.url} (providers: claude, antigravity)\n`]);
    expect(await failure(new Anthropic({ apiKey: "wrong", baseURL: `${daemon.url}/anthropic`, maxRetries: 0 }).models.list())).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(await failure(new OpenAI({ apiKey: "wrong", baseURL: `${daemon.url}/openai/v1`, maxRetries: 0 }).models.list())).toBeInstanceOf(OpenAI.AuthenticationError);
    const gemini = await new GoogleGenAI({ apiKey: "wrong", httpOptions: { baseUrl: `${daemon.url}/gemini` } }).models.generateContent({ model: GEMINI, contents: "hi" }).catch((e: unknown) => e);
    expect((gemini as ApiError).status).toBe(401);
    expect((await fetch(`${daemon.url}/nowhere`)).status).toBe(404);
  });
});

describe("daemon: Anthropic SDK → claude (native cell)", () => {
  test("messages.create: the upstream gets the captured envelope with the client's thinking choice (F9), the reply comes back", async () => {
    const message = await anthropic().messages.create({ model: HAIKU, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    expect(message.content[0]!.type).toBe("text");
    const sent = lastUpstream("/v1/messages");
    expect(sent.search).toBe("?beta=true");
    expect(sent.headers["authorization"]).toBe("Bearer sk-ant-oat01-REDACTED");
    expect(sent.headers["user-agent"]).toStartWith("claude-cli/");
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body["model"]).toBe("claude-haiku-4-5-20251001");
    expect("thinking" in body || "context_management" in body).toBe(false);
    expect((body["system"] as { text: string }[])[0]!.text).toStartWith("x-anthropic-billing-header:");
  });

  test("messages.stream: SSE passes through byte-identical; thinking enabled keeps the clear-thinking edit", async () => {
    const stream = anthropic().messages.stream({ model: HAIKU, max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "think" }] });
    const final = await stream.finalMessage();
    expect(final.content.some((b) => b.type === "thinking")).toBe(true);
    const body = JSON.parse(lastUpstream("/v1/messages").body) as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  });

  test("tool use round trip and count_tokens", async () => {
    const tools = [{ name: "get_time", description: "time", input_schema: { type: "object" as const, properties: { timezone: { type: "string" } } } }];
    const first = await anthropic().messages.create({ model: HAIKU, max_tokens: 256, tools, messages: [{ role: "user", content: "time?" }] });
    expect(first.stop_reason).toBe("tool_use");
    const count = await anthropic().messages.countTokens({ model: HAIKU, messages: [{ role: "user", content: "hi" }] });
    expect(count.input_tokens).toBe(654);
    const upstream = lastUpstream("/v1/messages/count_tokens");
    expect(upstream.search).toBe("?beta=true");
    expect(Object.keys(JSON.parse(upstream.body) as object).sort()).toEqual(["messages", "model", "system"]);
  });

  test("anthropic-beta: a captured name is accepted, an unproven one is a 400 unless x-proxy-lossy reports it", async () => {
    await anthropic().messages.create({ model: HAIKU, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, { headers: { "anthropic-beta": "oauth-2025-04-20" } });
    expect(lastUpstream("/v1/messages").headers["anthropic-beta"]).toStartWith("oauth-2025-04-20,");
    const refused = await anthropic().messages.create({ model: HAIKU, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, { headers: { "anthropic-beta": "files-api-2025-04-14" } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Anthropic.BadRequestError);
    expect((refused as InstanceType<typeof Anthropic.BadRequestError>).message).toContain("anthropic-beta:files-api-2025-04-14");
    const raw = await fetch(`${daemon.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json", "anthropic-beta": "files-api-2025-04-14", "x-proxy-lossy": "1" },
      body: JSON.stringify({ model: HAIKU, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    expect([raw.status, raw.headers.get("x-proxy-dropped")]).toEqual([200, "anthropic-beta:files-api-2025-04-14"]);
    await raw.text();
  });

  test("an upstream 429 passes through with retry-after; unknown and translated cells are proxy errors", async () => {
    const limited = await anthropic().messages.create({ model: "claude/claude-rate-limited", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(Anthropic.RateLimitError);
    expect((limited as InstanceType<typeof Anthropic.RateLimitError>).headers.get("retry-after")).toBe("17");
    expect(await failure(anthropic().messages.create({ model: "nope", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }))).toBeInstanceOf(Anthropic.NotFoundError);
    const translated = await anthropic().messages.create({ model: GEMINI, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect((translated as InstanceType<typeof Anthropic.BadRequestError>).message).toContain("the proxy does not translate between formats");
  });
});

describe("daemon: Google GenAI SDK → antigravity (near-native cell)", () => {
  test("generateContent merges the stream; the upstream gets the trajectory envelope and the catalog-exact budget", async () => {
    const response = await genai().models.generateContent({ model: GEMINI, contents: "hi" });
    expect(response.text).toBe("Hello, world!");
    expect(String(response.candidates![0]!.finishReason)).toBe("STOP");
    const envelope = JSON.parse(lastUpstream("/v1internal:streamGenerateContent").body) as { model: string; project: string; requestId: string; request: Record<string, unknown> };
    expect([envelope.model, envelope.project]).toEqual(["gemini-3.6-flash-low", "<REDACTED:projectids>"]);
    expect(envelope.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
    expect(typeof envelope.request["sessionId"]).toBe("string");
    expect(envelope.request["generationConfig"]).toEqual({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } });
    expect(lastUpstream("/v1internal:streamGenerateContent").headers["user-agent"]).toStartWith("antigravity/ide/");
  });

  test("generateContentStream yields each upstream response", async () => {
    const texts: string[] = [];
    for await (const chunk of await genai().models.generateContentStream({ model: GEMINI, contents: "hi" })) texts.push(chunk.text ?? "");
    expect(texts.join("")).toBe("Hello, world!");
  });

  test("a tool loop: the signed call is cached and replayed; the function response rides in a model turn (laws 6, 7)", async () => {
    const tools = [{ functionDeclarations: [{ name: "get_time", description: "time", parameters: { type: Type.OBJECT, properties: { timezone: { type: Type.STRING } } } }] }];
    const first = await genai().models.generateContent({ model: GEMINI, contents: "What time is it in Tokyo?", config: { tools } });
    const call = first.functionCalls![0]!;
    expect(call.name).toBe("get_time");
    const contents: Content[] = [
      { role: "user", parts: [{ text: "What time is it in Tokyo?" }] },
      { role: "model", parts: [{ functionCall: { id: call.id!, name: call.name!, args: call.args ?? {} } }] },
      { role: "user", parts: [{ functionResponse: { id: call.id!, name: call.name!, response: { output: "13:00" } } }] },
    ];
    const second = await genai().models.generateContent({ model: GEMINI, contents, config: { tools } });
    expect(second.text).toContain("Tokyo");
    const replayed = (JSON.parse(lastUpstream("/v1internal:streamGenerateContent").body) as { request: { contents: { role: string; parts: Record<string, unknown>[] }[] } }).request.contents;
    expect(typeof replayed[1]!.parts[0]!["thoughtSignature"]).toBe("string");
    expect(replayed[2]!.role).toBe("model");
  });

  test("countTokens and unknown fields are 400s; lossy reports the drop; an upstream 400 keeps its Google body", async () => {
    const count = await genai().models.countTokens({ model: GEMINI, contents: "hi" }).catch((e: unknown) => e);
    expect([(count as ApiError).status, (count as ApiError).message.includes("countTokens")]).toEqual([400, true]);
    const strict = await fetch(`${daemon.url}/gemini/v1beta/models/${GEMINI}:generateContent`, { method: "POST", headers: { "x-goog-api-key": token }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], safetySettings: [] }) });
    expect([strict.status, ((await strict.json()) as { error: { status: string } }).error.status]).toEqual([400, "INVALID_ARGUMENT"]);
    const lossy = await fetch(`${daemon.url}/gemini/v1beta/models/${GEMINI}:generateContent`, { method: "POST", headers: { "x-goog-api-key": token, "x-proxy-lossy": "1" }, body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], safetySettings: [] }) });
    expect([lossy.status, lossy.headers.get("x-proxy-dropped")]).toEqual([200, "safetySettings"]);
    await lossy.text();
    const upstream = await genai().models.generateContent({ model: "antigravity/gpt-oss-120b-medium", contents: "hi" }).catch((e: unknown) => e);
    expect([(upstream as ApiError).status, (upstream as ApiError).message.includes("Request contains an invalid argument.")]).toEqual([400, true]);
  });

  test("raw framing: SSE frames end in CRLF CRLF; without alt=sse the stream is one JSON array", async () => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] });
    const sse = await fetch(`${daemon.url}/gemini/v1beta/models/antigravity%2Fgemini-3.6-flash-low:streamGenerateContent?alt=sse&key=${token}`, { method: "POST", body });
    const frames = (await sse.text()).split("\r\n\r\n").filter((f) => f !== "");
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.startsWith("data: {"))).toBe(true);
    const array = await fetch(`${daemon.url}/gemini/v1beta/models/${GEMINI}:streamGenerateContent?key=${token}`, { method: "POST", body });
    expect(array.headers.get("content-type")).toBe("application/json");
    expect(((await array.json()) as unknown[]).length).toBe(3);
  });
});

describe("daemon: model lists in the three dialects", () => {
  test("Anthropic, OpenAI and Gemini SDKs list both providers; the source header says where each list came from", async () => {
    const ids: string[] = [];
    for await (const model of anthropic().models.list()) ids.push(model.id);
    expect(ids).toContain("claude/claude-opus-5");
    expect(ids).toContain(GEMINI);
    const openaiIds = (await openai().models.list()).data.map((m) => m.id);
    expect(openaiIds).toEqual(ids);
    const gemini: string[] = [];
    for await (const model of await genai().models.list()) gemini.push(model.name!);
    expect(gemini).toContain(`models/${GEMINI}`);
    const raw = await fetch(`${daemon.url}/openai/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(raw.headers.get("x-proxy-models-source")).toMatch(/^claude=(live|cache),antigravity=live$/);
    await raw.text();
  });

  test("OpenAI chat completions is a translated cell (P5): 400 unsupported_feature", async () => {
    const error = await openai().chat.completions.create({ model: HAIKU, messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as InstanceType<typeof OpenAI.BadRequestError>).code).toBe("unsupported_feature");
  });
});

/** Runs `work` with exactly these variables set (undefined = unset) and every name restored afterwards. */
async function withEnv(vars: Readonly<Record<string, string | undefined>>, work: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const assign = (values: Readonly<Record<string, string | undefined>>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(vars);
  try {
    await work();
  } finally {
    assign(saved);
  }
}

describe("daemon: SDKs configured only from the environment (client setup §3: tools built on the SDKs)", () => {
  test("Anthropic SDK: ANTHROPIC_BASE_URL with ANTHROPIC_API_KEY (x-api-key), or with ANTHROPIC_AUTH_TOKEN (Bearer)", async () => {
    const base = { ANTHROPIC_BASE_URL: `${daemon.url}/anthropic`, ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: undefined };
    await withEnv(base, async () => {
      const message = await new Anthropic({ maxRetries: 0 }).messages.create({ model: HAIKU, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
      expect(message.content[0]!.type).toBe("text");
    });
    await withEnv({ ...base, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: token }, async () => {
      const message = await new Anthropic({ maxRetries: 0 }).messages.create({ model: HAIKU, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
      expect(message.content[0]!.type).toBe("text");
    });
  });

  test("OpenAI SDK: OPENAI_BASE_URL and OPENAI_API_KEY", async () => {
    await withEnv({ OPENAI_BASE_URL: `${daemon.url}/openai/v1`, OPENAI_API_KEY: token }, async () => {
      expect((await new OpenAI({ maxRetries: 0 }).models.list()).data.map((m) => m.id)).toContain(GEMINI);
    });
  });

  test("Gen AI SDK: GOOGLE_GEMINI_BASE_URL with GEMINI_API_KEY, or with GOOGLE_API_KEY", async () => {
    const base = { GOOGLE_GEMINI_BASE_URL: `${daemon.url}/gemini`, GOOGLE_GENAI_USE_VERTEXAI: undefined, GOOGLE_API_KEY: undefined, GEMINI_API_KEY: token };
    await withEnv(base, async () => {
      const answer = await new GoogleGenAI({}).models.generateContent({ model: GEMINI, contents: "hi" });
      expect(answer.candidates?.length).toBeGreaterThan(0);
    });
    await withEnv({ ...base, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: token }, async () => {
      const answer = await new GoogleGenAI({}).models.generateContent({ model: GEMINI, contents: "hi" });
      expect(answer.candidates?.length).toBeGreaterThan(0);
    });
  });
});

describe("daemon: shutdown", () => {
  test("SIGTERM drains and exits 0 through the normal path", async () => {
    const stopped = await daemon.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("SIGTERM: stopping (in-flight responses get 10 s)\nstopped\n");
    // plan 2026-10-27 C1: after "listening on" every exchange record is printed too, credentials replaced.
    const records = stopped.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(new Set(records.map((r) => r["kind"]))).toEqual(new Set(["client-request", "client-response", "upstream-request", "upstream-response"]));
    expect(records.every((r) => r["schema"] === "accounts-proxy-exchange/1")).toBe(true);
    expect(stopped.stdout.includes(token)).toBe(false);
    daemon = undefined as never;
  });
});
