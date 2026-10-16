// P0-LIVE E3 (plan 2026-10-07-01-23 §4): fidelity matrix. Each probe is the minimal native request for its upstream —
// Anthropic Messages fields for T1, public Gemini fields inside the Antigravity envelope for T2–T4 — sent through the
// production session, transport and envelope. Each cell is classified from the observed response:
// ACCEPTED (200 and the effect observed), IGNORED (200, no effect), REJECTED (4xx, exact message kept).
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/e3-fidelity.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import type { ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { ChatMessage, EnvelopePart, StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import {
  PACE_MS,
  StopRun,
  anthropicContent,
  antigravityGenerate,
  antigravityModel,
  claudeMessages,
  openLive,
  sleep,
  stopReason,
  timestamp,
  writeCapture,
  writeDoc,
  type ClaudeResult,
  type Live,
} from "@accounts-proxy/scripts/evidence/live/harness.ts";

type Verdict = "ACCEPTED" | "IGNORED" | "REJECTED" | "BLOCKED";
type Cell = { target: string; probe: string; feature: string; verdict: Verdict; evidence: string };

/** Cells persist between runs (redacted) so a blocked probe can be re-run alone: `--only=t3:f9-implicit-cache,t4`. */
const CELLS_FILE = "tests/fixtures/captures/p0-live/e3/cells.json";
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((s) => s.length > 0);
const selected = (target: string, probeId: string) => only.length === 0 || only.some((o) => o === target || o === `${target}:${probeId}`);

const T1_MODEL = "claude-haiku-4-5-20251001";
const ANTIGRAVITY_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ["t2", "gemini-3.6-flash-low"],
  ["t3", "claude-sonnet-5-5-low"],
  ["t4", "gpt-oss-120b-medium"],
];
/** Output budget per probe: large enough that hidden thinking cannot consume it (see the evidence doc, deviation 1). */
const CLAUDE_MAX = 2048;
const CLAUDE_THINKING = { type: "enabled", budget_tokens: 1024 } as const;
const GEMINI_MAX = 2048;
const CODE_WORD = "PELICAN";

// ---------------------------------------------------------------- synthetic media (generated, no external files)

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** An 8×8 truecolour PNG of one colour (PNG spec: signature, IHDR, IDAT zlib stream, IEND). */
export function solidPng(r: number, g: number, b: number): string {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const body = Buffer.concat([head.subarray(4), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = [0, ...Array.from({ length: 8 }, () => [r, g, b]).flat()];
  const raw = Uint8Array.from(Array.from({ length: 8 }, () => row).flat());
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
  return png.toString("base64");
}

/** A one-page PDF 1.4 whose only text is the code-word sentence (xref offsets computed). */
export function codeWordPdf(): string {
  const text = `BT /F1 24 Tf 72 700 Td (The code word is ${CODE_WORD}.) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

const RED_PNG = solidPng(255, 0, 0);
const PDF = codeWordPdf();
const LONG_CONTEXT = Array.from({ length: 220 }, (_, i) => `Clause ${i + 1}: the archive keeps every ledger entry for seven years and indexes it by account, date and amount.`).join("\n");

const TOOLS = {
  get_time: { name: "get_time", description: "Current local time in an IANA timezone.", schema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } },
  get_weather: { name: "get_weather", description: "Current weather for a city.", schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
};
/** Effect checks are whole-word: a refusal that merely quotes the instruction must not count as compliance. */
const RED = /\bred\b/i;
const SYSTEM_PROMPT = "Always answer in French, whatever language the user writes in.";
const SYSTEM_QUESTION = "What colour is a clear daytime sky? One word.";
const FRENCH = /\bbleu/i;
const TIME_PROMPT = "What time is it in Tokyo? Use a tool if one is available.";
const BOTH_PROMPT = "In a single turn, call get_time for Asia/Tokyo AND get_weather for Paris (two tool calls at once).";

// ---------------------------------------------------------------- run bookkeeping

const cells: Cell[] = [];
const capturedAt = new Date().toISOString();

async function probe(live: Live, target: string, probeId: string, feature: string, model: string, run: () => Promise<{ verdict: Verdict; evidence: string }>): Promise<void> {
  if (!selected(target, probeId)) return;
  const mark = live.recorder.mark();
  const started = performance.now();
  let result: { verdict: Verdict; evidence: string };
  let stop: StopRun | undefined;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof StopRun) {
      stop = error;
      result = { verdict: "BLOCKED", evidence: `run stopped: ${error.message}` };
    } else {
      // A transport failure is not a verdict on the feature: BLOCKED, with the reason and the elapsed time (plan §4).
      const name = error instanceof Error ? error.name : "Error";
      result = { verdict: "BLOCKED", evidence: `${name}: ${error instanceof Error ? error.message : String(error)} after ${Math.round(performance.now() - started)} ms` };
    }
  }
  const id = `${target}-${probeId}`;
  writeCapture(live, `tests/fixtures/captures/p0-live/e3/${id}.json`, { id, target, scenario: probeId, model, capturedAt, exchanges: live.recorder.since(mark) });
  const evidence = live.redactor.text(result.evidence).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 400);
  const index = cells.findIndex((c) => c.target === target && c.probe === probeId);
  const cell = { target, probe: probeId, feature, verdict: result.verdict, evidence };
  if (index >= 0) cells[index] = cell;
  else cells.push(cell);
  writeCells(live);
  console.log(`${id} ${result.verdict}: ${evidence}`);
  if (stop !== undefined) throw stop;
  await sleep(PACE_MS);
}

function loadCells(): void {
  const path = join(repositoryRoot, CELLS_FILE);
  if (existsSync(path)) cells.push(...(JSON.parse(readFileSync(path, "utf8")) as Cell[]));
}

function writeCells(live: Live): void {
  const order = (c: Cell) => `${c.target}/${c.probe}`;
  cells.sort((a, b) => order(a).localeCompare(order(b)));
  writeDoc(live, CELLS_FILE, `${JSON.stringify(cells, null, 2)}\n`);
}

const rejected = (status: number, text: string) => ({ verdict: "REJECTED" as const, evidence: `HTTP ${status}: ${text.slice(0, 300)}` });

// ---------------------------------------------------------------- T1 (Anthropic Messages, native)

function claudeView(r: ClaudeResult) {
  const blocks = anthropicContent(r.events);
  const text = blocks.filter((b) => b["type"] === "text").map((b) => String(b["text"])).join("");
  const calls = blocks.filter((b) => b["type"] === "tool_use");
  const start = r.events.find((e) => e["type"] === "message_start")?.["message"] as Record<string, unknown> | undefined;
  const delta = r.events.find((e) => e["type"] === "message_delta");
  const usage = { ...((start?.["usage"] as Record<string, unknown>) ?? {}), ...((delta?.["usage"] as Record<string, unknown>) ?? {}) };
  return { blocks, text, calls, stop: stopReason(r.events), stopSequence: (delta?.["delta"] as Record<string, unknown> | undefined)?.["stop_sequence"], usage };
}

async function t1(live: Live): Promise<void> {
  const m = T1_MODEL;
  // Thinking cannot be disabled through the captured envelope (first run: every `thinking: disabled` probe was a 400,
  // see deviation 1), so every T1 probe carries the smallest explicit budget.
  const base = { model: m, max_tokens: CLAUDE_MAX, stream: true, thinking: CLAUDE_THINKING };
  const send = (body: Record<string, unknown>) => claudeMessages(live, m, { ...base, ...body });
  const anthropicTools = (names: ReadonlyArray<keyof typeof TOOLS>) => names.map((n) => ({ name: TOOLS[n].name, description: TOOLS[n].description, input_schema: TOOLS[n].schema }));

  await probe(live, "t1", "f1-image", "image input", m, async () => {
    const r = await send({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG } }, { type: "text", text: "What single colour fills this image? One word." }] }] });
    if (r.status !== 200) return rejected(r.status, r.text);
    const v = claudeView(r);
    return { verdict: RED.test(v.text) ? "ACCEPTED" : "IGNORED", evidence: `answer=${JSON.stringify(v.text)}` };
  });
  await probe(live, "t1", "f2-document", "document (PDF) input", m, async () => {
    const r = await send({ messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } }, { type: "text", text: "What is the code word in the document? Reply with the word only." }] }] });
    if (r.status !== 200) return rejected(r.status, r.text);
    const v = claudeView(r);
    return { verdict: v.text.toUpperCase().includes(CODE_WORD) ? "ACCEPTED" : "IGNORED", evidence: `answer=${JSON.stringify(v.text)}` };
  });
  const choices: ReadonlyArray<readonly [string, Record<string, unknown>, string, (v: ReturnType<typeof claudeView>) => boolean]> = [
    ["f3a-tool-choice-auto", { type: "auto" }, TIME_PROMPT, () => true],
    ["f3b-tool-choice-any", { type: "any" }, "Say hello.", (v) => v.calls.length > 0],
    ["f3c-tool-choice-none", { type: "none" }, TIME_PROMPT, (v) => v.calls.length === 0],
    ["f3d-tool-choice-tool", { type: "tool", name: "get_time" }, "Say hello.", (v) => v.calls.some((c) => c["name"] === "get_time")],
  ];
  for (const [id, choice, prompt, effect] of choices) {
    await probe(live, "t1", id, `tool_choice ${String(choice["type"])}`, m, async () => {
      const r = await send({ tools: anthropicTools(["get_time"]), tool_choice: choice, messages: [{ role: "user", content: prompt }] });
      if (r.status !== 200) return rejected(r.status, r.text);
      const v = claudeView(r);
      return { verdict: effect(v) ? "ACCEPTED" : "IGNORED", evidence: `stop=${v.stop} calls=${v.calls.map((c) => c["name"]).join(",") || "none"} text=${JSON.stringify(v.text.slice(0, 80))}` };
    });
  }
  await probe(live, "t1", "f4-parallel-tools", "parallel tool calls", m, async () => {
    const r = await send({ tools: anthropicTools(["get_time", "get_weather"]), messages: [{ role: "user", content: BOTH_PROMPT }] });
    if (r.status !== 200) return rejected(r.status, r.text);
    const v = claudeView(r);
    return { verdict: v.calls.length >= 2 ? "ACCEPTED" : "IGNORED", evidence: `calls in one turn=${v.calls.map((c) => c["name"]).join(",") || "none"}` };
  });
  await probe(live, "t1", "f5-thinking-replay", "thinking + signature replay", m, async () => {
    const first = { ...base, tools: anthropicTools(["get_time"]), messages: [{ role: "user", content: TIME_PROMPT }] as unknown[] };
    const r1 = await claudeMessages(live, m, first);
    if (r1.status !== 200) return rejected(r1.status, r1.text);
    const v1 = claudeView(r1);
    const thinking = v1.blocks.find((b) => b["type"] === "thinking");
    const call = v1.calls[0];
    if (call === undefined) return { verdict: "IGNORED", evidence: `no tool call to replay; blocks=${v1.blocks.map((b) => b["type"]).join(",")}` };
    await sleep(PACE_MS);
    const r2 = await claudeMessages(live, m, {
      ...first,
      messages: [...first.messages, { role: "assistant", content: v1.blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: call["id"], content: "13:00" }] }],
    });
    if (r2.status !== 200) return rejected(r2.status, r2.text);
    return { verdict: thinking?.["signature"] ? "ACCEPTED" : "IGNORED", evidence: `turn1 blocks=${v1.blocks.map((b) => b["type"]).join(",")} signature=${Boolean(thinking?.["signature"])}; replay HTTP 200 stop=${claudeView(r2).stop}` };
  });
  await probe(live, "t1", "f6-stop-sequences", "stop sequences", m, async () => {
    const r = await send({ stop_sequences: ["5"], messages: [{ role: "user", content: "Count from 1 to 10, separated by single spaces, nothing else." }] });
    if (r.status !== 200) return rejected(r.status, r.text);
    const v = claudeView(r);
    return { verdict: v.stop === "stop_sequence" && !v.text.includes("5") ? "ACCEPTED" : "IGNORED", evidence: `stop=${v.stop} stop_sequence=${String(v.stopSequence)} text=${JSON.stringify(v.text)}` };
  });
  for (const [id, field, value] of [
    ["f7a-temperature", "temperature", 0],
    ["f7b-top-p", "top_p", 0.5],
    ["f7c-top-k", "top_k", 5],
  ] as const) {
    await probe(live, "t1", id, field, m, async () => {
      const r = await send({ [field]: value, messages: [{ role: "user", content: "Reply with the single word OK." }] });
      if (r.status !== 200) return rejected(r.status, r.text);
      return { verdict: "ACCEPTED", evidence: `HTTP 200 (sampling effect not observable in one draw; acceptance only) text=${JSON.stringify(claudeView(r).text)}` };
    });
  }
  await probe(live, "t1", "f8-system", "system prompt", m, async () => {
    const r = await send({ system: SYSTEM_PROMPT, messages: [{ role: "user", content: SYSTEM_QUESTION }] });
    if (r.status !== 200) return rejected(r.status, r.text);
    const v = claudeView(r);
    return { verdict: FRENCH.test(v.text) ? "ACCEPTED" : "IGNORED", evidence: `answer=${JSON.stringify(v.text)}` };
  });
  await probe(live, "t1", "f9-cache-control", "cache_control ephemeral", m, async () => {
    const body = { system: [{ type: "text", text: LONG_CONTEXT, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "How many years are entries kept? Number only." }] };
    const r1 = await send(body);
    if (r1.status !== 200) return rejected(r1.status, r1.text);
    await sleep(PACE_MS);
    const r2 = await send(body);
    if (r2.status !== 200) return rejected(r2.status, r2.text);
    const u1 = claudeView(r1).usage;
    const u2 = claudeView(r2).usage;
    const read = Number(u2["cache_read_input_tokens"] ?? 0);
    return { verdict: read > 0 ? "ACCEPTED" : "IGNORED", evidence: `call1 input=${String(u1["input_tokens"])} cache_creation=${String(u1["cache_creation_input_tokens"])}; call2 cache_read=${read}` };
  });
}

// ---------------------------------------------------------------- T2–T4 (Gemini fields in the Antigravity envelope)

type GeminiView = { ok: boolean; status?: number; error?: string; text: string; thought: string; calls: EnvelopePart[]; finish?: string; usage: Record<string, unknown>; parts: EnvelopePart[] };

function geminiView(r: { ok: boolean; status?: number; error?: string; envelopes: StreamEnvelope[] }): GeminiView {
  const parts = r.envelopes.flatMap((e) => e.response?.candidates?.[0]?.content?.parts ?? []);
  const finish = r.envelopes.map((e) => e.response?.candidates?.[0]?.finishReason).filter((f) => f !== undefined).pop();
  const usage = (r.envelopes.map((e) => e.response?.usageMetadata).filter((u) => u !== undefined).pop() ?? {}) as Record<string, unknown>;
  return {
    ok: r.ok,
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    text: parts.filter((p) => p.thought !== true && p.text).map((p) => p.text).join(""),
    thought: parts.filter((p) => p.thought === true && p.text).map((p) => p.text).join(""),
    calls: parts.filter((p) => p.functionCall !== undefined),
    ...(finish !== undefined ? { finish } : {}),
    usage,
    parts,
  };
}

async function antigravityTarget(live: Live, target: string, wireId: string): Promise<void> {
  const model: ModelDescriptor = await antigravityModel(live, wireId);
  const send = async (fields: { contents: unknown[]; systemInstruction?: unknown; tools?: unknown; toolConfig?: unknown; generationConfig?: Record<string, unknown> }, view: ChatMessage[]) => {
    const r = await antigravityGenerate(live, model, view, (s) => ({
      contents: fields.contents,
      ...(fields.systemInstruction !== undefined ? { systemInstruction: fields.systemInstruction } : {}),
      ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
      ...(fields.toolConfig !== undefined ? { toolConfig: fields.toolConfig } : {}),
      labels: s.labels,
      generationConfig: { maxOutputTokens: GEMINI_MAX, ...(fields.generationConfig ?? {}) },
      sessionId: s.sessionId,
    }));
    return geminiView(r);
  };
  const user = (text: string, extra: unknown[] = []) => ({ contents: [{ role: "user", parts: [...extra, { text }] }], view: [{ role: "user", text } as ChatMessage] });
  const geminiTools = (names: ReadonlyArray<keyof typeof TOOLS>) => [{ functionDeclarations: names.map((n) => ({ name: TOOLS[n].name, description: TOOLS[n].description, parameters: { type: "OBJECT", properties: Object.fromEntries(Object.keys(TOOLS[n].schema.properties).map((k) => [k, { type: "STRING" }])), required: TOOLS[n].schema.required } })) }];
  const fail = (v: GeminiView) => rejected(v.status ?? 0, String(v.error));

  await probe(live, target, "f1-image", "image input", wireId, async () => {
    const u = user("What single colour fills this image? One word.", [{ inlineData: { mimeType: "image/png", data: RED_PNG } }]);
    const v = await send({ contents: u.contents }, u.view);
    if (!v.ok) return fail(v);
    return { verdict: RED.test(v.text) ? "ACCEPTED" : "IGNORED", evidence: `finish=${v.finish} answer=${JSON.stringify(v.text)}` };
  });
  await probe(live, target, "f2-document", "document (PDF) input", wireId, async () => {
    const u = user("What is the code word in the document? Reply with the word only.", [{ inlineData: { mimeType: "application/pdf", data: PDF } }]);
    const v = await send({ contents: u.contents }, u.view);
    if (!v.ok) return fail(v);
    return { verdict: v.text.toUpperCase().includes(CODE_WORD) ? "ACCEPTED" : "IGNORED", evidence: `finish=${v.finish} answer=${JSON.stringify(v.text)}` };
  });
  const modes: ReadonlyArray<readonly [string, Record<string, unknown>, string, (v: GeminiView) => boolean]> = [
    ["f3a-tool-choice-auto", { mode: "AUTO" }, TIME_PROMPT, () => true],
    ["f3b-tool-choice-any", { mode: "ANY" }, "Say hello.", (v) => v.calls.length > 0],
    ["f3c-tool-choice-none", { mode: "NONE" }, TIME_PROMPT, (v) => v.calls.length === 0],
    ["f3d-tool-choice-tool", { mode: "ANY", allowedFunctionNames: ["get_time"] }, "Say hello.", (v) => v.calls.some((c) => c.functionCall?.name === "get_time")],
  ];
  for (const [id, config, prompt, effect] of modes) {
    await probe(live, target, id, `functionCallingConfig ${JSON.stringify(config)}`, wireId, async () => {
      const u = user(prompt);
      const v = await send({ contents: u.contents, tools: geminiTools(["get_time"]), toolConfig: { functionCallingConfig: config } }, u.view);
      if (!v.ok) return fail(v);
      return { verdict: effect(v) ? "ACCEPTED" : "IGNORED", evidence: `finish=${v.finish} calls=${v.calls.map((c) => c.functionCall?.name).join(",") || "none"} text=${JSON.stringify(v.text.slice(0, 80))}` };
    });
  }
  await probe(live, target, "f4-parallel-tools", "parallel tool calls", wireId, async () => {
    const u = user(BOTH_PROMPT);
    const v = await send({ contents: u.contents, tools: geminiTools(["get_time", "get_weather"]), toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } }, u.view);
    if (!v.ok) return fail(v);
    return { verdict: v.calls.length >= 2 ? "ACCEPTED" : "IGNORED", evidence: `calls in one turn=${v.calls.map((c) => c.functionCall?.name).join(",") || "none"}` };
  });
  await probe(live, target, "f5-thinking-replay", "thinking + signature replay", wireId, async () => {
    const thinkingConfig = model.thinkingBudget !== undefined ? { includeThoughts: true, thinkingBudget: model.thinkingBudget } : { includeThoughts: true };
    const u = user(TIME_PROMPT);
    const tools = geminiTools(["get_time"]);
    const toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
    const v1 = await send({ contents: u.contents, tools, toolConfig, generationConfig: { thinkingConfig } }, u.view);
    if (!v1.ok) return fail(v1);
    const call = v1.calls[0];
    if (call === undefined) return { verdict: "IGNORED", evidence: `thinkingConfig=${JSON.stringify(thinkingConfig)} no functionCall to replay; thoughtChars=${v1.thought.length}` };
    await sleep(PACE_MS);
    const fc = call.functionCall!;
    const replayed = { functionCall: fc, ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}) };
    const contents = [...u.contents, { role: "model", parts: [replayed] }, { role: "model", parts: [{ functionResponse: { ...(fc.id !== undefined ? { id: fc.id } : {}), name: fc.name, response: { output: "13:00" } } }] }];
    const view: ChatMessage[] = [...u.view, { role: "assistant", text: "", toolCalls: [{ id: fc.id ?? fc.name, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) }] }, { role: "tool", text: "13:00", toolCallId: fc.id ?? fc.name, toolName: fc.name }];
    const v2 = await send({ contents, tools, toolConfig, generationConfig: { thinkingConfig } }, view);
    if (!v2.ok) return fail(v2);
    const thoughts = v1.thought.length > 0;
    return {
      verdict: thoughts ? "ACCEPTED" : "IGNORED",
      evidence: `thinkingConfig=${JSON.stringify(thinkingConfig)} turn1 thoughtChars=${v1.thought.length} thoughtsTokenCount=${String(v1.usage["thoughtsTokenCount"])} signedCall=${call.thoughtSignature !== undefined}; replay finish=${v2.finish}`,
    };
  });
  await probe(live, target, "f6-stop-sequences", "stopSequences", wireId, async () => {
    const u = user("Count from 1 to 10, separated by single spaces, nothing else.");
    const v = await send({ contents: u.contents, generationConfig: { stopSequences: ["5"] } }, u.view);
    if (!v.ok) return fail(v);
    return { verdict: v.text.length > 0 && !v.text.includes("5") ? "ACCEPTED" : "IGNORED", evidence: `finish=${v.finish} text=${JSON.stringify(v.text)}` };
  });
  for (const [id, field, value] of [
    ["f7a-temperature", "temperature", 0],
    ["f7b-top-p", "topP", 0.5],
    ["f7c-top-k", "topK", 5],
  ] as const) {
    await probe(live, target, id, field, wireId, async () => {
      const u = user("Reply with the single word OK.");
      const v = await send({ contents: u.contents, generationConfig: { [field]: value } }, u.view);
      if (!v.ok) return fail(v);
      return { verdict: "ACCEPTED", evidence: `HTTP 200 (sampling effect not observable in one draw; acceptance only) finish=${v.finish} text=${JSON.stringify(v.text)}` };
    });
  }
  await probe(live, target, "f8-system", "systemInstruction", wireId, async () => {
    const u = user(SYSTEM_QUESTION);
    const v = await send({ contents: u.contents, systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] } }, u.view);
    if (!v.ok) return fail(v);
    return { verdict: FRENCH.test(v.text) ? "ACCEPTED" : "IGNORED", evidence: `finish=${v.finish} answer=${JSON.stringify(v.text)}` };
  });
  await probe(live, target, "f9-implicit-cache", "prompt cache (implicit; no request field)", wireId, async () => {
    const u = user(`${LONG_CONTEXT}\n\nHow many years are entries kept? Number only.`);
    const v1 = await send({ contents: u.contents }, u.view);
    if (!v1.ok) return fail(v1);
    await sleep(PACE_MS);
    const v2 = await send({ contents: u.contents }, u.view);
    if (!v2.ok) return fail(v2);
    const cached = Number(v2.usage["cachedContentTokenCount"] ?? 0);
    return { verdict: cached > 0 ? "ACCEPTED" : "IGNORED", evidence: `call1 prompt=${String(v1.usage["promptTokenCount"])}; call2 cachedContentTokenCount=${cached}` };
  });
}

// ---------------------------------------------------------------- main

async function quotaText(live: Live): Promise<string> {
  try {
    return (await live.antigravity.quota.usage()).text;
  } catch (error) {
    return `quota unavailable: ${String(error)}`;
  }
}

/** One run of this script: which probes, the Antigravity quota before/after, and whether it stopped early. */
type Run = { startedAt: string; only: string[]; probes: number; stopped?: string; quotaBefore: string; quotaAfter: string };
const RUNS_FILE = "tests/fixtures/captures/p0-live/e3/runs.json";

function loadRuns(): Run[] {
  const path = join(repositoryRoot, RUNS_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Run[]) : [];
}

/** Probes that do not exist for a target (cache marker vs implicit cache). */
const NOT_APPLICABLE: Readonly<Record<string, readonly string[]>> = { "f9-cache-control": ["t2", "t3", "t4"], "f9-implicit-cache": ["t1"] };

async function main(): Promise<number> {
  const live = await openLive();
  loadCells();
  const runs = loadRuns();
  if (!process.argv.includes("--doc-only")) {
    const startedAt = new Date().toISOString();
    const before = await quotaText(live);
    let stopped: string | undefined;
    try {
      await t1(live);
      for (const [target, wireId] of ANTIGRAVITY_TARGETS) await antigravityTarget(live, target, wireId);
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
      stopped = error.message;
    }
    const after = await quotaText(live);
    runs.push({
      startedAt,
      only,
      probes: cells.filter((c) => selected(c.target, c.probe)).length,
      ...(stopped !== undefined ? { stopped } : {}),
      quotaBefore: live.redactor.text(before.trim()),
      quotaAfter: live.redactor.text(after.trim()),
    });
    writeDoc(live, RUNS_FILE, `${JSON.stringify(runs, null, 2)}\n`);
  }
  const stopped = runs.find((r) => r.stopped !== undefined)?.stopped;
  const ts = timestamp();
  const targets = ["t1", ...ANTIGRAVITY_TARGETS.map(([t]) => t)];
  const probes = [...new Set(cells.map((c) => c.probe))].sort();
  const verdictOf = (t: string, p: string) => cells.find((c) => c.target === t && c.probe === p)?.verdict ?? (NOT_APPLICABLE[p]?.includes(t) ? "n/a" : "not run");
  const matrix = probes.map((p) => `| ${p} | ${targets.map((t) => verdictOf(t, p)).join(" | ")} |`).join("\n");
  const detail = cells.map((c) => `| ${c.target} | ${c.probe} | ${c.feature.replaceAll("|", "\\|")} | ${c.verdict} | ${c.evidence} | \`tests/fixtures/captures/p0-live/e3/${c.target}-${c.probe}.json\` |`).join("\n");
  const runLog = runs
    .map((r, i) => `### Run ${i + 1}: ${r.startedAt}, ${r.only.length === 0 ? "all probes" : `only ${r.only.join(", ")}`} (${r.probes} cells)${r.stopped !== undefined ? ` — stopped: ${r.stopped}` : ""}\n\nBefore:\n\`\`\`\n${r.quotaBefore}\n\`\`\`\n\nAfter:\n\`\`\`\n${r.quotaAfter}\n\`\`\``)
    .join("\n\n");
  writeDoc(
    live,
    `docs/reference/${ts}-fidelity-matrix.md`,
    `# P0-LIVE E3: fidelity matrix

Generated by \`scripts/evidence/live/e3-fidelity.ts\` (plan [2026-10-07-01-23-p0-live-gate-plan.md](../plans/2026-10-07-01-23-p0-live-gate-plan.md) §4)
from \`${CELLS_FILE}\` (the latest verdict per cell) and \`${RUNS_FILE}\` (every run).

Targets: T1 \`claude/${T1_MODEL}\` (native Anthropic Messages) · ${ANTIGRAVITY_TARGETS.map(([t, w]) => `${t.toUpperCase()} \`antigravity/${w}\``).join(" · ")} (public Gemini fields inside the Antigravity envelope).
Every probe went through the production session, envelope and transport; requests were 2 s apart; a run stops at the first quota signal.

Verdicts: **ACCEPTED** = HTTP 200 and the effect was observed; **IGNORED** = HTTP 200 and no effect; **REJECTED** = 4xx (message kept);
**BLOCKED** = the probe could not complete (transport failure or stopped run); **n/a** = the probe does not exist for that target.
${stopped !== undefined ? `\n**A run stopped early:** ${stopped}\n` : ""}
## Matrix

| Probe | ${targets.map((t) => t.toUpperCase()).join(" | ")} |
|---|${targets.map(() => "---").join("|")}|
${matrix}

## Evidence

| Target | Probe | Feature | Verdict | Observed | Capture |
|---|---|---|---|---|---|
${detail}

## Deviations from the plan (stated, not hidden)

1. **Output budget and thinking.** The plan asked for \`max_tokens\`/\`maxOutputTokens\` ≤ 32. E2 showed that a Claude
   request without \`thinking\` receives the captured envelope default \`{"type":"enabled","budget_tokens":31999}\`, so 32
   output tokens are all spent on thinking (t1-s1-plain: \`stop_reason: max_tokens\`, empty text). A first E3 run then
   sent \`thinking: {"type":"disabled"}\`: every such T1 probe was rejected with HTTP 400 \`clear_thinking_20251015
   strategy requires thinking to be enabled or adaptive\`, because the envelope always adds
   \`context_management.edits[clear_thinking_20251015]\` (captures kept in
   \`tests/fixtures/captures/p0-live/e3/first-run-thinking-disabled/\`). Through the envelope, thinking cannot be
   disabled. Every T1 probe therefore carries \`thinking: ${JSON.stringify(CLAUDE_THINKING)}\` with \`max_tokens\`
   ${CLAUDE_MAX}. The Antigravity probes use \`maxOutputTokens\` ${GEMINI_MAX} because Gemini thinks even without
   \`thinkingConfig\` (E2 t2-s1-plain: \`thoughtsTokenCount\` 81 for the answer "OK").
2. **F7 sampling.** One draw cannot show the effect of \`temperature\`/\`top_p\`/\`top_k\`; those cells record acceptance (HTTP 200) only.
3. **F9 on Antigravity.** Public Gemini has no request-level cache marker equivalent to \`cache_control\`; the probe
   measures implicit caching (\`cachedContentTokenCount\` on an identical second request).
4. **F8 probe text.** The first full run used "always answer BANANA"; Haiku declined while quoting the instruction, which
   a substring check counted as compliance. F8 (and F1, whose check became whole-word) were re-run on all targets with
   "Always answer in French" / "What colour is a clear daytime sky?" and a whole-word check.

## Runs and Antigravity quota (\`quota antigravity\`)

${runLog}
`,
  );
  console.log(`wrote docs/reference/${ts}-fidelity-matrix.md (${cells.length} cells)${stopped ? ` — a run stopped: ${stopped}` : ""}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
