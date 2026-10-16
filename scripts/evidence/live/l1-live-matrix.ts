// Live validation L1/L2 (docs/plans/2026-10-13-01-42-live-validation-plan.md): the real daemon (`serve` from the
// production composition root, in this process so that its upstream traffic goes through the recording transport)
// answers the official Anthropic, OpenAI and Google Gen AI SDKs for every provider's native cells.
//   primary cell per provider: s1 plain, s2 plain streamed, s3 three-turn conversation, s4 tool round trip,
//     s5 MCP-style tool definition, s5b the same with `x-proxy-lossy: 1`, s6 unknown model
//   secondary cells: s2 plain streamed in each other native format
//   L2 (--only=l2): one forced renewal of the openai and the OpenCode Console sessions, then one request each
// One request at a time, 2 s apart; a 429 or 402 stops that provider's remaining requests (no retry, no rotation).
// Captures (redacted, secret-scanned): tests/fixtures/captures/p0-live/l1/<cell>-<scenario>.json; the findings table:
// docs/reference/<ts>-l1-live-matrix.md.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/l1-live-matrix.ts [--only=<cell|provider|l2|l2-openai|l2-opencode>,...]
//          [--scenarios=s1,s5,...]
// Zen's deepseek-v4-flash and kimi-k2.6 answered 404/410 "Upstream request failed: Endpoint is unavailable." on the
// documented path (l1-zen-chat-check.ts, 2026-10-13); the Zen Chat cell uses glm-5.1, which answered 200.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { join } from "node:path";
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { SystemBrowserLauncher } from "@accounts-proxy/proxy/adapters/outbound/browser-launcher.ts";
import { opencodeDataDir } from "@accounts-proxy/proxy/adapters/outbound/opencode-auth-file.ts";
import { ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";
import { LOOPBACK_HOST, PRODUCTION_LOCK, runCli, type ContainerOptions } from "@accounts-proxy/proxy/composition/container.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const onlyScenarios = (process.argv.find((a) => a.startsWith("--scenarios=")) ?? "").slice("--scenarios=".length).split(",").filter((x) => x !== "");

type Scenario = "s1" | "s2" | "s3" | "s4" | "s5" | "s5b" | "s6";
const FULL: readonly Scenario[] = ["s1", "s2", "s3", "s4", "s5", "s5b", "s6"];
type Cell = { readonly id: string; readonly provider: string; readonly format: WireFormat; readonly model: string; readonly scenarios: readonly Scenario[] };

const CELLS: readonly Cell[] = [
  { id: "claude-msg", provider: "claude", format: "anthropic-messages", model: "claude-haiku-4-5-20251001", scenarios: FULL },
  { id: "antigravity-gem", provider: "antigravity", format: "gemini", model: "gemini-3.5-flash-lite", scenarios: FULL },
  { id: "antigravity-claude", provider: "antigravity", format: "gemini", model: "claude-sonnet-5-5-low", scenarios: ["s2", "s5", "s5b"] },
  { id: "openai-resp", provider: "openai", format: "openai-responses", model: "gpt-5.6-luna", scenarios: FULL },
  { id: "openrouter-chat", provider: "openrouter", format: "openai-chat", model: "nvidia/nemotron-3.5-lightning:free", scenarios: FULL },
  { id: "openrouter-msg", provider: "openrouter", format: "anthropic-messages", model: "nvidia/nemotron-3.5-lightning:free", scenarios: ["s2"] },
  { id: "openrouter-resp", provider: "openrouter", format: "openai-responses", model: "nvidia/nemotron-3.5-lightning:free", scenarios: ["s2"] },
  { id: "opencode-chat", provider: "opencode", format: "openai-chat", model: "glm-5.1", scenarios: FULL },
  { id: "opencode-msg", provider: "opencode", format: "anthropic-messages", model: "claude-haiku-4-5", scenarios: ["s2"] },
  { id: "opencode-gem", provider: "opencode", format: "gemini", model: "gemini-3.5-flash-lite", scenarios: ["s2"] },
  { id: "opencode-resp", provider: "opencode", format: "openai-responses", model: "gpt-5.4-nano", scenarios: ["s2"] },
  { id: "go-chat", provider: "opencode-go", format: "openai-chat", model: "glm-5.3-flash", scenarios: FULL },
  { id: "go-msg", provider: "opencode-go", format: "anthropic-messages", model: "qwen3.8-flash", scenarios: ["s2"] },
  { id: "go-resp", provider: "opencode-go", format: "openai-responses", model: "gpt-5.6-luna", scenarios: ["s2"] },
  { id: "cheaper-chat", provider: "cheaper-inference", format: "openai-chat", model: "gpt-5.4-nano", scenarios: FULL },
  { id: "cheaper-msg", provider: "cheaper-inference", format: "anthropic-messages", model: "gpt-5.4-nano", scenarios: ["s2"] },
  { id: "cheaper-resp", provider: "cheaper-inference", format: "openai-responses", model: "gpt-5.4-nano", scenarios: ["s2"] },
];

const OK = "Reply with the single word OK.";
const TURNS = ["My code word is PLUM. Reply with the single word OK.", "What is 2 + 3? Reply with the number only.", "What was my code word? Reply with the word only."];
const TOOL_PROMPT = "What time is it in Tokyo? Use the get_time tool, then answer with the time.";
const TOOL_RESULT = '{"time":"16:05","timezone":"Asia/Tokyo"}';
const MCP_PROMPT = "Read the file /etc/hostname with the read_file tool.";
const GET_TIME_SCHEMA = { type: "object", properties: { timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo" } }, required: ["timezone"] };
/** The shape the MCP TypeScript SDK publishes for a zod tool input (zod-to-json-schema, draft-07). */
const MCP_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of the file" },
    limit: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }], default: null, description: "Maximum number of lines" },
  },
  required: ["path"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

/** What a scenario observed on the client side (SDK view). */
type Outcome = { readonly status: number; readonly summary: string; readonly dropped?: string | null };
type Row = { readonly cell: string; readonly scenario: string; readonly status: number; readonly summary: string; readonly dropped: string; readonly upstream: string; readonly ms: number };

class ManualShutdown extends ShutdownSignal {
  private release: (name: string) => void = () => undefined;
  private readonly asked = new Promise<string>((resolve) => (this.release = resolve));
  wait(): Promise<string> {
    return this.asked;
  }
  stop(): void {
    this.release("SIGTERM");
  }
}

function options(live: Live, out: (text: string) => void, shutdown: ShutdownSignal): ContainerOptions {
  return {
    home: live.home,
    opencodeData: opencodeDataDir(process.env),
    entry: [process.execPath, join(import.meta.dir, "..", "..", "..", "apps", "proxy", "src", "main", "cli.ts")],
    out,
    err: out,
    stdin: process.stdin,
    stdout: process.stdout,
    seams: {},
    transport: live.recorder,
    browser: new SystemBrowserLauncher(process.platform),
    shutdown,
    listenHost: LOOPBACK_HOST,
    lock: PRODUCTION_LOCK,
  };
}

const clip = (text: string, n = 160) => text.replace(/\s+/g, " ").trim().slice(0, n);

/** SDK errors (all three SDKs) carry the HTTP status and the server's message. */
function failed(error: unknown): Outcome {
  const e = error as { status?: unknown; message?: unknown };
  if (typeof e.status === "number") return { status: e.status, summary: `error: ${clip(String(e.message), 300)}` };
  throw error;
}

// ---------------------------------------------------------------- the three client dialects

type Client = {
  plain(model: string, stream: boolean): Promise<Outcome>;
  conversation(model: string): Promise<Outcome>;
  toolLoop(model: string): Promise<Outcome>;
  mcpTool(model: string, lossy: boolean): Promise<Outcome>;
};

function anthropicClient(base: string, token: string, extra: Record<string, string>): Client {
  const client = (lossy = false) => new Anthropic({ apiKey: token, baseURL: `${base}/anthropic`, maxRetries: 0, timeout: 180_000, defaultHeaders: { ...extra, ...(lossy ? { "x-proxy-lossy": "1" } : {}) } });
  const text = (m: Anthropic.Message) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const tools = (m: Anthropic.Message) => m.content.flatMap((b) => (b.type === "tool_use" ? [`${b.name}(${JSON.stringify(b.input)})`] : []));
  const describe = (m: Anthropic.Message, extraText = "") => `stop=${m.stop_reason} text=${JSON.stringify(clip(text(m)))}${tools(m).length > 0 ? ` tool_use=${tools(m).join(";")}` : ""}${extraText}`;
  const create = async (body: Omit<Anthropic.MessageCreateParamsNonStreaming, "max_tokens">, lossy = false) => {
    const { data, response } = await client(lossy).messages.create({ max_tokens: 1024, ...body }).withResponse();
    return { message: data, dropped: response.headers.get("x-proxy-dropped") };
  };
  return {
    async plain(model, stream) {
      if (!stream) {
        const { message } = await create({ model, messages: [{ role: "user", content: OK }] });
        return { status: 200, summary: describe(message) };
      }
      const s = client().messages.stream({ model, max_tokens: 1024, messages: [{ role: "user", content: OK }] });
      let events = 0;
      s.on("streamEvent", () => void events++);
      const message = await s.finalMessage();
      return { status: 200, summary: describe(message, ` events=${events}`) };
    },
    async conversation(model) {
      const messages: Anthropic.MessageParam[] = [];
      const answers: string[] = [];
      for (const turn of TURNS) {
        messages.push({ role: "user", content: turn });
        const { message } = await create({ model, messages: [...messages] });
        messages.push({ role: "assistant", content: message.content });
        answers.push(clip(text(message), 40));
        await sleep(PACE_MS);
      }
      return { status: 200, summary: `answers=${JSON.stringify(answers)}` };
    },
    async toolLoop(model) {
      const tool = { name: "get_time", description: "Current local time in an IANA timezone.", input_schema: GET_TIME_SCHEMA as Anthropic.Tool.InputSchema };
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: TOOL_PROMPT }];
      const first = (await create({ model, tools: [tool], messages })).message;
      const call = first.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (call === undefined) return { status: 200, summary: `no tool call: ${describe(first)}` };
      await sleep(PACE_MS);
      messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: TOOL_RESULT }] });
      const second = (await create({ model, tools: [tool], messages })).message;
      return { status: 200, summary: `call=${call.name}(${JSON.stringify(call.input)}) → ${describe(second)}` };
    },
    async mcpTool(model, lossy) {
      const { message, dropped } = await create({ model, tools: [{ name: "read_file", description: "Read a text file.", input_schema: MCP_SCHEMA as unknown as Anthropic.Tool.InputSchema }], messages: [{ role: "user", content: MCP_PROMPT }] }, lossy);
      return { status: 200, summary: describe(message), dropped };
    },
  };
}

function chatClient(base: string, token: string, extra: Record<string, string>): Client {
  const client = (lossy = false) => new OpenAI({ apiKey: token, baseURL: `${base}/openai/v1`, maxRetries: 0, timeout: 180_000, defaultHeaders: { ...extra, ...(lossy ? { "x-proxy-lossy": "1" } : {}) } });
  const describe = (c: OpenAI.ChatCompletion, extraText = "") => {
    const choice = c.choices[0];
    const calls = (choice?.message.tool_calls ?? []).flatMap((t) => (t.type === "function" ? [`${t.function.name}(${t.function.arguments})`] : []));
    return `finish=${choice?.finish_reason} text=${JSON.stringify(clip(choice?.message.content ?? ""))}${calls.length > 0 ? ` tool_calls=${calls.join(";")}` : ""}${extraText}`;
  };
  const create = async (body: OpenAI.ChatCompletionCreateParamsNonStreaming, lossy = false) => {
    const { data, response } = await client(lossy).chat.completions.create(body).withResponse();
    return { completion: data, dropped: response.headers.get("x-proxy-dropped") };
  };
  const getTime: OpenAI.ChatCompletionTool = { type: "function", function: { name: "get_time", description: "Current local time in an IANA timezone.", parameters: GET_TIME_SCHEMA } };
  return {
    async plain(model, stream) {
      if (!stream) return { status: 200, summary: describe((await create({ model, messages: [{ role: "user", content: OK }] })).completion) };
      const s = client().chat.completions.stream({ model, messages: [{ role: "user", content: OK }] });
      let chunks = 0;
      s.on("chunk", () => void chunks++);
      return { status: 200, summary: describe(await s.finalChatCompletion(), ` chunks=${chunks}`) };
    },
    async conversation(model) {
      const messages: OpenAI.ChatCompletionMessageParam[] = [];
      const answers: string[] = [];
      for (const turn of TURNS) {
        messages.push({ role: "user", content: turn });
        const { completion } = await create({ model, messages: [...messages] });
        const content = completion.choices[0]?.message.content ?? "";
        messages.push({ role: "assistant", content });
        answers.push(clip(content, 40));
        await sleep(PACE_MS);
      }
      return { status: 200, summary: `answers=${JSON.stringify(answers)}` };
    },
    async toolLoop(model) {
      const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: TOOL_PROMPT }];
      const first = (await create({ model, tools: [getTime], messages })).completion;
      const call = first.choices[0]?.message.tool_calls?.find((t) => t.type === "function");
      if (call === undefined || call.type !== "function") return { status: 200, summary: `no tool call: ${describe(first)}` };
      await sleep(PACE_MS);
      messages.push({ role: "assistant", content: first.choices[0]!.message.content ?? null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: TOOL_RESULT });
      const second = (await create({ model, tools: [getTime], messages })).completion;
      return { status: 200, summary: `call=${call.function.name}(${call.function.arguments}) → ${describe(second)}` };
    },
    async mcpTool(model, lossy) {
      const { completion, dropped } = await create({ model, tools: [{ type: "function", function: { name: "read_file", description: "Read a text file.", parameters: MCP_SCHEMA } }], messages: [{ role: "user", content: MCP_PROMPT }] }, lossy);
      return { status: 200, summary: describe(completion), dropped };
    },
  };
}

function responsesClient(base: string, token: string, extra: Record<string, string>): Client {
  const client = (lossy = false) => new OpenAI({ apiKey: token, baseURL: `${base}/openai/v1`, maxRetries: 0, timeout: 180_000, defaultHeaders: { ...extra, ...(lossy ? { "x-proxy-lossy": "1" } : {}) } });
  const calls = (r: OpenAI.Responses.Response) => r.output.flatMap((i) => (i.type === "function_call" ? [i] : []));
  const describe = (r: OpenAI.Responses.Response, extraText = "") => `status=${r.status} text=${JSON.stringify(clip(r.output_text ?? ""))}${calls(r).length > 0 ? ` function_calls=${calls(r).map((c) => `${c.name}(${c.arguments})`).join(";")}` : ""}${extraText}`;
  const create = async (body: OpenAI.Responses.ResponseCreateParamsNonStreaming, lossy = false) => {
    const { data, response } = await client(lossy).responses.create(body).withResponse();
    return { response: data, dropped: response.headers.get("x-proxy-dropped") };
  };
  /** Stateless history (store: false): assistant text as a message, function calls without their item ids. */
  const history = (r: OpenAI.Responses.Response): OpenAI.Responses.ResponseInputItem[] =>
    r.output.flatMap((i): OpenAI.Responses.ResponseInputItem[] => {
      if (i.type === "message") return [{ role: "assistant", content: i.content.flatMap((c) => (c.type === "output_text" ? [c.text] : [])).join("") }];
      if (i.type === "function_call") return [{ type: "function_call", call_id: i.call_id, name: i.name, arguments: i.arguments }];
      return [];
    });
  const getTime: OpenAI.Responses.FunctionTool = { type: "function", name: "get_time", description: "Current local time in an IANA timezone.", parameters: GET_TIME_SCHEMA, strict: false };
  return {
    async plain(model, stream) {
      if (!stream) return { status: 200, summary: describe((await create({ model, input: OK })).response) };
      const s = client().responses.stream({ model, input: OK });
      let events = 0;
      s.on("event", () => void events++);
      return { status: 200, summary: describe(await s.finalResponse(), ` events=${events}`) };
    },
    async conversation(model) {
      const input: OpenAI.Responses.ResponseInputItem[] = [];
      const answers: string[] = [];
      for (const turn of TURNS) {
        input.push({ role: "user", content: turn });
        const { response } = await create({ model, input: [...input] });
        input.push(...history(response));
        answers.push(clip(response.output_text ?? "", 40));
        await sleep(PACE_MS);
      }
      return { status: 200, summary: `answers=${JSON.stringify(answers)}` };
    },
    async toolLoop(model) {
      const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: TOOL_PROMPT }];
      const first = (await create({ model, tools: [getTime], input })).response;
      const call = calls(first)[0];
      if (call === undefined) return { status: 200, summary: `no tool call: ${describe(first)}` };
      await sleep(PACE_MS);
      input.push(...history(first), { type: "function_call_output", call_id: call.call_id, output: TOOL_RESULT });
      const second = (await create({ model, tools: [getTime], input })).response;
      return { status: 200, summary: `call=${call.name}(${call.arguments}) → ${describe(second)}` };
    },
    async mcpTool(model, lossy) {
      const { response, dropped } = await create({ model, tools: [{ type: "function", name: "read_file", description: "Read a text file.", parameters: MCP_SCHEMA, strict: false }], input: MCP_PROMPT }, lossy);
      return { status: 200, summary: describe(response), dropped };
    },
  };
}

function geminiClient(base: string, token: string, extra: Record<string, string>): Client {
  const client = (lossy = false) => new GoogleGenAI({ apiKey: token, httpOptions: { baseUrl: `${base}/gemini`, timeout: 180_000, headers: { ...extra, ...(lossy ? { "x-proxy-lossy": "1" } : {}) } } });
  const describe = (r: GenerateContentResponse, extraText = "") => {
    const calls = (r.functionCalls ?? []).map((c) => `${c.name}(${JSON.stringify(c.args)})`);
    return `finish=${r.candidates?.[0]?.finishReason} text=${JSON.stringify(clip(r.text ?? ""))}${calls.length > 0 ? ` function_calls=${calls.join(";")}` : ""}${extraText}`;
  };
  const dropped = (r: GenerateContentResponse) => r.sdkHttpResponse?.headers?.["x-proxy-dropped"] ?? null;
  const getTime = { functionDeclarations: [{ name: "get_time", description: "Current local time in an IANA timezone.", parameters: GET_TIME_SCHEMA as never }] };
  return {
    async plain(model, stream) {
      if (!stream) return { status: 200, summary: describe(await client().models.generateContent({ model, contents: OK })) };
      let chunks = 0;
      let text = "";
      let last: GenerateContentResponse | undefined;
      for await (const chunk of await client().models.generateContentStream({ model, contents: OK })) {
        chunks++;
        text += chunk.text ?? "";
        last = chunk;
      }
      return { status: 200, summary: `finish=${last?.candidates?.[0]?.finishReason} text=${JSON.stringify(clip(text))} chunks=${chunks}` };
    },
    async conversation(model) {
      const contents: Content[] = [];
      const answers: string[] = [];
      for (const turn of TURNS) {
        contents.push({ role: "user", parts: [{ text: turn }] });
        const r = await client().models.generateContent({ model, contents: [...contents] });
        contents.push(r.candidates?.[0]?.content ?? { role: "model", parts: [{ text: "" }] });
        answers.push(clip(r.text ?? "", 40));
        await sleep(PACE_MS);
      }
      return { status: 200, summary: `answers=${JSON.stringify(answers)}` };
    },
    async toolLoop(model) {
      const contents: Content[] = [{ role: "user", parts: [{ text: TOOL_PROMPT }] }];
      const first = await client().models.generateContent({ model, contents, config: { tools: [getTime] } });
      const call = first.functionCalls?.[0];
      if (call === undefined) return { status: 200, summary: `no tool call: ${describe(first)}` };
      await sleep(PACE_MS);
      contents.push(first.candidates![0]!.content!, { role: "user", parts: [{ functionResponse: { name: call.name!, ...(call.id !== undefined ? { id: call.id } : {}), response: JSON.parse(TOOL_RESULT) as Record<string, unknown> } }] });
      const second = await client().models.generateContent({ model, contents, config: { tools: [getTime] } });
      return { status: 200, summary: `call=${call.name}(${JSON.stringify(call.args)}) → ${describe(second)}` };
    },
    async mcpTool(model, lossy) {
      const r = await client(lossy).models.generateContent({ model, contents: MCP_PROMPT, config: { tools: [{ functionDeclarations: [{ name: "read_file", description: "Read a text file.", parameters: MCP_SCHEMA as never }] }] } });
      return { status: 200, summary: describe(r), dropped: dropped(r) };
    },
  };
}

// ---------------------------------------------------------------- run

async function main(): Promise<number> {
  const live = await openLive();
  // The gateway API keys are only in the authorization header (redacted by name); they are also secrets for the scan.
  for (const gateway of live.gateways) live.redactor.add(`${gateway.spec.provider}_key`, await gateway.session.optionalKey());
  let tokenText = "";
  await runCli(["token"], options(live, (t) => void (tokenText += t), new ManualShutdown()));
  const token = tokenText.trim();
  live.redactor.add("proxy_token", token);

  let daemonOut = "";
  const shutdown = new ManualShutdown();
  const serving = runCli(["serve"], options(live, (t) => void (daemonOut += t), shutdown));
  for (let i = 0; i < 3000 && !daemonOut.includes("listening on"); i++) await sleep(10);
  const base = /listening on (http:\/\/\S+)/.exec(daemonOut)?.[1];
  if (base === undefined) throw new Error(`serve did not start: ${daemonOut}`);
  const capturedAt = new Date().toISOString();
  const session = { "x-opencode-session": `ses_l1_${Date.now()}` };
  const clients: Record<WireFormat, Client> = {
    "anthropic-messages": anthropicClient(base, token, session),
    "openai-chat": chatClient(base, token, session),
    "openai-responses": responsesClient(base, token, session),
    gemini: geminiClient(base, token, session),
  };

  const rows: Row[] = [];
  const stopped = new Map<string, string>();
  const step = async (cell: Cell, scenario: string, run: () => Promise<Outcome>) => {
    if (stopped.has(cell.provider)) return;
    const mark = live.recorder.mark();
    const started = performance.now();
    const outcome = await run().catch(failed);
    const exchanges = live.recorder.since(mark);
    const id = `${cell.id}-${scenario}`;
    writeCapture(live, `tests/fixtures/captures/p0-live/l1/${id}.json`, { id, target: cell.provider, scenario, model: cell.model, capturedAt, exchanges });
    const upstream = exchanges.map((e) => `${e.status ?? "-"} ${new URL(e.request.url).pathname.split("/").slice(-1)[0]}`).join(", ");
    const row: Row = { cell: cell.id, scenario, status: outcome.status, summary: live.redactor.text(outcome.summary), dropped: outcome.dropped ?? "", upstream, ms: Math.round(performance.now() - started) };
    rows.push(row);
    console.log(`${id}: ${row.status} ${row.summary}${row.dropped !== "" ? ` dropped=${row.dropped}` : ""} [upstream ${upstream}]`);
    if (outcome.status === 429 || outcome.status === 402) stopped.set(cell.provider, `${id}: HTTP ${outcome.status}`);
    await sleep(PACE_MS);
  };

  const wantedCell = (cell: Cell) => only.length === 0 || only.includes(cell.id) || only.includes(cell.provider);
  /** L2 runs on a full run, or for `l2` (both sessions), `l2-openai`, `l2-opencode`. */
  const wantedRenewal = (name: string) => only.length === 0 || only.includes("l2") || only.includes(`l2-${name}`);
  for (const cell of CELLS) {
    if (!wantedCell(cell)) continue;
    const client = clients[cell.format];
    const model = `${cell.provider}/${cell.model}`;
    for (const scenario of cell.scenarios.filter((x) => onlyScenarios.length === 0 || onlyScenarios.includes(x))) {
      if (scenario === "s1") await step(cell, "s1-plain", () => client.plain(model, false));
      if (scenario === "s2") await step(cell, "s2-plain-stream", () => client.plain(model, true));
      if (scenario === "s3") await step(cell, "s3-three-turns", () => client.conversation(model));
      if (scenario === "s4") await step(cell, "s4-tool-loop", () => client.toolLoop(model));
      if (scenario === "s5") await step(cell, "s5-mcp-tool", () => client.mcpTool(model, false));
      if (scenario === "s5b") await step(cell, "s5b-mcp-tool-lossy", () => client.mcpTool(model, true));
      if (scenario === "s6") await step(cell, "s6-unknown-model", () => client.plain(`${cell.provider}/no-such-model-l1`, false));
    }
  }

  // L2: one forced renewal per renewing session that has not been proven live (openai, the OpenCode Console).
  {
    const renewals: Array<{ cell: Cell; renew: () => Promise<string> }> = [];
    if (live.openai !== undefined && wantedRenewal("openai")) {
      const openai = live.openai;
      renewals.push({
        cell: CELLS.find((c) => c.id === "openai-resp")!,
        renew: async () => {
          const before = await openai.session.active();
          const after = await openai.session.forceRenew(before);
          return `access token ${before.account.accessToken === after.account.accessToken ? "unchanged" : "replaced"}, refresh token ${before.account.refreshToken === after.account.refreshToken ? "unchanged" : "rotated"}, expires in ${Math.round((after.account.expiresAt - Date.now()) / 60000)} min`;
        },
      });
    }
    const console_ = live.gateways.find((g) => g.console !== undefined)?.console;
    if (console_ !== undefined && wantedRenewal("opencode")) {
      renewals.push({
        cell: CELLS.find((c) => c.id === "opencode-chat")!,
        renew: async () => {
          const before = await console_.session.active();
          const after = await console_.session.forceRenew(before);
          if (before.account.kind !== "device" || after.account.kind !== "device") return `not a device sign-in (${before.account.kind})`;
          const [b, a] = [before.account.tokens, after.account.tokens];
          return `access token ${b.accessToken === a.accessToken ? "unchanged" : "replaced"}, refresh token ${b.refreshToken === a.refreshToken ? "unchanged" : "rotated"}, workspace ${b.orgId === a.orgId ? "kept" : "changed"}, expires in ${Math.round((a.expiresAt - Date.now()) / 60000)} min`;
        },
      });
    }
    for (const { cell, renew } of renewals) {
      await step(cell, "l2-force-renew", async () => {
        const summary = await renew();
        // The renewed tokens are new secrets: they join the redactor before the capture is written.
        const pool = await live.graph.store.load(cell.provider as never);
        for (const account of pool.accounts) {
          for (const [k, v] of Object.entries(account.data as Record<string, unknown>)) if (typeof v === "string" && /token|key/i.test(k)) live.redactor.add(`${cell.provider}_${k}_renewed`, v);
        }
        return { status: 200, summary };
      });
      await step(cell, "l2-after-renew", () => clients[cell.format].plain(`${cell.provider}/${cell.model}`, true));
    }
  }

  shutdown.stop();
  const code = await serving;
  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-l1-live-matrix.md`,
    `# Live validation L1/L2: every provider through the daemon

Generated by \`scripts/evidence/live/l1-live-matrix.ts\` on ${capturedAt}
([plan](../plans/2026-10-13-01-42-live-validation-plan.md)). The daemon is the production composition root
(\`runCli(["serve"])\`) in the script's process over the recording transport; the clients are the official SDKs
(@anthropic-ai/sdk, openai, @google/genai) on the proxy's own routes and token. Captures:
\`tests/fixtures/captures/p0-live/l1/<cell>-<scenario>.json\` (redacted, secret-scanned; token-endpoint exchanges are
omitted). Daemon exit: ${code}.

| Cell | Scenario | HTTP (client) | Observed (client side) | x-proxy-dropped | Upstream calls | ms |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.cell} | ${r.scenario} | ${r.status} | ${r.summary.replaceAll("|", "\\|")} | ${r.dropped} | ${r.upstream} | ${r.ms} |`).join("\n")}

${stopped.size > 0 ? `Stopped providers (429/402): ${[...stopped.values()].join("; ")}.\n` : "No provider answered 429 or 402.\n"}
Daemon output:
\`\`\`
${live.redactor.text(daemonOut).trim()}
\`\`\`
`,
  );
  console.log(`wrote docs/reference/${ts}-l1-live-matrix.md`);
  return 0;
}

process.exit(await main());
