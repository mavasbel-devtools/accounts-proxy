// P0-LIVE E2 (plan 2026-10-07-01-23 §3): native streaming captures. Targets T1 (claude native Messages), T2
// (antigravity Gemini model), T3 (antigravity Claude model); scenarios S1 plain text, S2 tool loop (two requests),
// S3 thinking. Usage: INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/e2-capture.ts
import { GenerateCodec, type ChatMessage, type ChatRequest } from "@inference-router/provider-antigravity/domain/generate.ts";
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
  type Live,
} from "@inference-router/scripts/evidence/live/harness.ts";

const T1_MODEL = "claude-haiku-4-5-20251001";
const T2_MODEL = "gemini-3.6-flash-low";
const T3_MODEL = "claude-sonnet-5-5-low";

const PLAIN = "Reply with the single word OK.";
const TOOL_PROMPT = "What time is it in Tokyo right now? Use the get_time tool, then answer in one sentence.";
const TOOL_RESULT = "2026-10-11T13:00:00+09:00";
const THINK_PROMPT = "Is 391 a prime number? Think it through, then answer yes or no.";
const GET_TIME = {
  name: "get_time",
  description: "Current local time in an IANA timezone.",
  parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo" } }, required: ["timezone"] },
};

type Row = { id: string; target: string; scenario: string; model: string; status: string; ttfbMs: string; chunks: number; durationMs: string; observed: string; file: string };
const rows: Row[] = [];
const capturedAt = new Date().toISOString();

async function capture(live: Live, target: string, scenario: string, model: string, run: () => Promise<string>): Promise<void> {
  const id = `${target}-${scenario}`;
  const mark = live.recorder.mark();
  let observed: string;
  let failure: unknown;
  try {
    observed = await run();
  } catch (error) {
    failure = error;
    observed = `ERROR ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
  }
  const exchanges = live.recorder.since(mark);
  const file = `tests/fixtures/captures/p0-live/${id}.json`;
  writeCapture(live, file, { id, target, scenario, model, capturedAt, exchanges });
  const inference = exchanges.filter((x) => /streamGenerateContent|\/v1\/messages/.test(x.request.url));
  for (const [index, e] of inference.entries()) {
    rows.push({
      id: inference.length > 1 ? `${id} #${index + 1}` : id,
      target,
      scenario,
      model,
      status: String(e.status ?? "-"),
      ttfbMs: e.chunks[0] ? e.chunks[0].atMs.toFixed(0) : "-",
      chunks: e.chunks.length,
      durationMs: e.doneAtMs !== undefined ? e.doneAtMs.toFixed(0) : "-",
      observed: live.redactor.text(observed).replaceAll("|", "\\|").replaceAll("\n", " "),
      file,
    });
  }
  console.log(`${id}: ${observed}`);
  if (failure instanceof StopRun) throw failure;
  await sleep(PACE_MS);
}

// ---------------------------------------------------------------- T1 claude

async function t1(live: Live): Promise<void> {
  await capture(live, "t1", "s1-plain", T1_MODEL, async () => {
    const r = await claudeMessages(live, T1_MODEL, { model: T1_MODEL, max_tokens: 32, stream: true, messages: [{ role: "user", content: PLAIN }] });
    return `HTTP ${r.status} stop=${stopReason(r.events)} text=${JSON.stringify(anthropicContent(r.events).map((b) => b["text"]).join(""))}`;
  });
  await capture(live, "t1", "s2-tool-loop", T1_MODEL, async () => {
    const tools = [{ name: GET_TIME.name, description: GET_TIME.description, input_schema: GET_TIME.parameters }];
    const first = { model: T1_MODEL, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: TOOL_PROMPT }] };
    const r1 = await claudeMessages(live, T1_MODEL, first);
    const content = anthropicContent(r1.events);
    const call = content.find((b) => b["type"] === "tool_use");
    if (call === undefined) return `HTTP ${r1.status} stop=${stopReason(r1.events)} no tool_use`;
    await sleep(PACE_MS);
    const r2 = await claudeMessages(live, T1_MODEL, {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call["id"], content: TOOL_RESULT }] },
      ],
    });
    const text = anthropicContent(r2.events).map((b) => b["text"] ?? "").join("");
    return `call ${String(call["name"])}(${JSON.stringify(call["input"])}) stop1=${stopReason(r1.events)}; HTTP ${r2.status} stop2=${stopReason(r2.events)} text=${JSON.stringify(text)}`;
  });
  await capture(live, "t1", "s3-thinking", T1_MODEL, async () => {
    const r = await claudeMessages(live, T1_MODEL, {
      model: T1_MODEL,
      max_tokens: 2048,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: THINK_PROMPT }],
    });
    const blocks = anthropicContent(r.events);
    const thinking = blocks.find((b) => b["type"] === "thinking");
    return `HTTP ${r.status} stop=${stopReason(r.events)} blocks=${blocks.map((b) => b["type"]).join(",")} thinkingChars=${String(thinking?.["thinking"] ?? "").length} signature=${thinking?.["signature"] !== undefined} text=${JSON.stringify(blocks.filter((b) => b["type"] === "text").map((b) => b["text"]).join("").slice(0, 80))}`;
  });
}

// ---------------------------------------------------------------- T2/T3 antigravity

async function antigravityTarget(live: Live, target: string, wireId: string): Promise<void> {
  const model = await antigravityModel(live, wireId);
  const codec = new GenerateCodec();
  const request = (messages: ChatMessage[], extra: Partial<ChatRequest> = {}): ChatRequest => ({
    modelWireId: model.wireId,
    modelEnum: model.enumPlaceholder,
    maxOutputTokens: model.maxOutputTokens,
    messages,
    ...extra,
  });
  const run = async (req: ChatRequest) => {
    const r = await antigravityGenerate(live, model, req.messages, (s) => codec.toGenerateBody(req, { labels: s.labels, sessionId: s.sessionId }) as unknown as Record<string, unknown>);
    const chunks = r.envelopes.map((e) => codec.envelopeToChunk(e)).filter((c) => c !== undefined);
    return { r, chunks };
  };
  const summary = (r: { ok: boolean; status?: number; error?: string }, chunks: ReturnType<GenerateCodec["envelopeToChunk"]>[]) => {
    if (!r.ok) return `HTTP ${r.status} ${String(r.error).slice(0, 160)}`;
    const text = chunks.map((c) => c?.deltaText ?? "").join("");
    const thought = chunks.map((c) => c?.thoughtText ?? "").join("");
    const finish = chunks.map((c) => c?.finishReason).filter((f) => f !== undefined).pop();
    return `finish=${finish} thoughtChars=${thought.length} text=${JSON.stringify(text.slice(0, 80))}`;
  };

  await capture(live, target, "s1-plain", wireId, async () => {
    const { r, chunks } = await run(request([{ role: "user", text: PLAIN }]));
    return summary(r, chunks);
  });
  await capture(live, target, "s2-tool-loop", wireId, async () => {
    const user: ChatMessage = { role: "user", text: TOOL_PROMPT };
    const first = await run(request([user], { tools: [GET_TIME] }));
    const calls = first.chunks.flatMap((c) => c?.toolCalls ?? []);
    if (!first.r.ok || calls.length === 0) return `first: ${summary(first.r, first.chunks)} no functionCall`;
    await sleep(PACE_MS);
    const call = calls[0]!;
    const second = await run(
      request(
        [user, { role: "assistant", text: first.chunks.map((c) => c?.deltaText ?? "").join(""), toolCalls: [call] }, { role: "tool", text: TOOL_RESULT, toolCallId: call.id, toolName: call.name }],
        { tools: [GET_TIME] },
      ),
    );
    return `call ${call.name}(${call.arguments}) id=${call.id}; second: ${summary(second.r, second.chunks)}`;
  });
  await capture(live, target, "s3-thinking", wireId, async () => {
    if (model.thinkingBudget === undefined) return "catalog advertises no thinkingBudget: skipped";
    const { r, chunks } = await run(request([{ role: "user", text: THINK_PROMPT }], { thinkingBudget: model.thinkingBudget }));
    return `thinkingBudget=${model.thinkingBudget} ${summary(r, chunks)}`;
  });
}

async function main(): Promise<number> {
  const live = await openLive();
  let stopped: string | undefined;
  try {
    await t1(live);
    await antigravityTarget(live, "t2", T2_MODEL);
    await antigravityTarget(live, "t3", T3_MODEL);
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    stopped = error.message;
  }
  const ts = timestamp();
  const table = rows.map((r) => `| ${r.id} | \`${r.model}\` | ${r.status} | ${r.ttfbMs} | ${r.chunks} | ${r.durationMs} | ${r.observed} | \`${r.file}\` |`).join("\n");
  writeDoc(
    live,
    `docs/reference/${ts}-p0-live-e2-captures.md`,
    `# P0-LIVE E2: native streaming captures

Generated by \`scripts/evidence/live/e2-capture.ts\` on ${capturedAt} (plan [2026-10-07-01-23-p0-live-gate-plan.md](../plans/2026-10-07-01-23-p0-live-gate-plan.md) §3).
Every request went through the production adapters (router composition root) over a recording transport; captures are
redacted (credentials, account ids, email, project, device/session ids) and secret-scanned before writing.
Token-endpoint exchanges are never persisted, only counted.

${stopped !== undefined ? `**Run stopped early:** ${stopped}\n\n` : ""}| Capture | Model | HTTP | First chunk (ms) | Chunks | Done (ms) | Observed | File |
|---|---|---|---|---|---|---|---|
${table}
`,
  );
  console.log(`wrote docs/reference/${ts}-p0-live-e2-captures.md (${rows.length} exchanges)${stopped ? ` — STOPPED: ${stopped}` : ""}`);
  return stopped === undefined ? 0 : 3;
}

process.exit(await main());
