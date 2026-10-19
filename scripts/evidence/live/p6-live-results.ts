// P6 live results (docs/plans/2026-10-17-22-59-p6-live-results-plan.md): every native cell through a running daemon,
// measured from the client side with raw HTTP (no SDK buffering): three streamed runs and one non-streamed run per
// cell, plus Gemini's JSON-array stream and the two counting endpoints. Per request: status, headers, time to the first
// event, time to first token, the network reads that carried answer text (count, span, gaps), the terminal event.
// One request at a time, 2 s apart; a 429 or 402 stops that provider (no retry, no account switch).
// The results document is docs/reference/<ts>-p6-live-results.md (secret-scanned); no captures are written.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/p6-live-results.ts [--base=http://127.0.0.1:4141]
//          [--only=<cell|provider>,...] [--runs=3]
//        bun scripts/evidence/live/p6-live-results.ts --replay   (checks the runner against the e2e replay upstreams;
//          only the claude and antigravity cells have scripted answers there; nothing is written)
import { join } from "node:path";
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { PACE_MS, openLive, sleep, timestamp, writeDoc } from "@accounts-proxy/scripts/evidence/live/harness.ts";
import { Redactor } from "@accounts-proxy/scripts/evidence/live/redact.ts";
import { analyseStream, bodyText, isCount, jsonArrayEvents, sseEvents, type BodyRead, type StreamAnalysis } from "@accounts-proxy/scripts/evidence/live/stream-timing.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { startSignedInDaemon } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = (arg("only") ?? "").split(",").filter((x) => x !== "");
const RUNS = Number(arg("runs") ?? "3");
const replay = process.argv.includes("--replay");

type Cell = { readonly id: string; readonly provider: string; readonly format: WireFormat; readonly model: string; readonly extra?: "json-array" | "count" };
const CELLS: readonly Cell[] = [
  { id: "claude-msg", provider: "claude", format: "anthropic-messages", model: "claude-haiku-4-5-20251001", extra: "count" },
  { id: "antigravity-gem", provider: "antigravity", format: "gemini", model: "gemini-3.5-flash-lite", extra: "json-array" },
  { id: "antigravity-claude", provider: "antigravity", format: "gemini", model: "claude-sonnet-5-5-low" },
  { id: "openai-resp", provider: "openai", format: "openai-responses", model: "gpt-5.6-luna" },
  { id: "openrouter-chat", provider: "openrouter", format: "openai-chat", model: "nvidia/nemotron-3.5-lightning:free" },
  { id: "openrouter-msg", provider: "openrouter", format: "anthropic-messages", model: "nvidia/nemotron-3.5-lightning:free" },
  { id: "openrouter-resp", provider: "openrouter", format: "openai-responses", model: "nvidia/nemotron-3.5-lightning:free" },
  { id: "opencode-chat", provider: "opencode", format: "openai-chat", model: "glm-5.1" },
  { id: "opencode-msg", provider: "opencode", format: "anthropic-messages", model: "claude-haiku-4-5" },
  { id: "opencode-gem", provider: "opencode", format: "gemini", model: "gemini-3.5-flash-lite" },
  { id: "opencode-resp", provider: "opencode", format: "openai-responses", model: "gpt-5.4-nano" },
  { id: "go-chat", provider: "opencode-go", format: "openai-chat", model: "glm-5.3-flash" },
  { id: "go-msg", provider: "opencode-go", format: "anthropic-messages", model: "qwen3.8-flash" },
  { id: "go-resp", provider: "opencode-go", format: "openai-responses", model: "gpt-5.6-luna" },
  { id: "cheaper-chat", provider: "cheaper-inference", format: "openai-chat", model: "gpt-5.4-nano" },
  { id: "cheaper-msg", provider: "cheaper-inference", format: "anthropic-messages", model: "gpt-5.4-nano", extra: "count" },
  { id: "cheaper-resp", provider: "cheaper-inference", format: "openai-responses", model: "gpt-5.4-nano" },
];

const COUNT_TO = 40;
const PROMPT = `Count from 1 to ${COUNT_TO}, separated by spaces. Output only the numbers.`;
const REQUEST_ID_HEADERS = ["request-id", "x-request-id", "x-oai-request-id", "x-opencode-log-id", "x-generation-id", "x-ci-request-id"];

type Mode = "stream" | "plain" | "json-array" | "count";
type Row = {
  readonly cell: Cell;
  readonly mode: Mode;
  readonly run: number;
  readonly status: number;
  readonly contentType: string;
  readonly dropped: string;
  readonly requestId: string;
  readonly headersMs: number;
  readonly totalMs: number;
  readonly analysis: StreamAnalysis | undefined;
  readonly text: string;
  readonly error: string;
};

/** The request of a cell: path and body in the cell's format. */
function request(cell: Cell, mode: Mode): { path: string; body: unknown; headers: Record<string, string> } {
  const model = `${cell.provider}/${cell.model}`;
  const stream = mode === "stream";
  switch (cell.format) {
    case "anthropic-messages": {
      const messages = [{ role: "user", content: PROMPT }];
      const headers = { "anthropic-version": "2023-06-01" };
      if (mode === "count") return { path: "/anthropic/v1/messages/count_tokens", body: { model, messages }, headers };
      return { path: "/anthropic/v1/messages", body: { model, max_tokens: 1024, messages, ...(stream ? { stream } : {}) }, headers };
    }
    case "openai-chat":
      return { path: "/openai/v1/chat/completions", body: { model, messages: [{ role: "user", content: PROMPT }], ...(stream ? { stream } : {}) }, headers: {} };
    case "openai-responses":
      return { path: "/openai/v1/responses", body: { model, input: PROMPT, ...(stream ? { stream } : {}) }, headers: {} };
    case "gemini": {
      const method = mode === "plain" ? "generateContent" : mode === "json-array" ? "streamGenerateContent" : "streamGenerateContent?alt=sse";
      return { path: `/gemini/v1beta/models/${encodeURIComponent(model)}:${method}`, body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }] }, headers: {} };
    }
  }
}

async function measure(base: string, token: string, cell: Cell, mode: Mode, run: number): Promise<Row> {
  const { path, body, headers } = request(cell, mode);
  const started = performance.now();
  const since = () => performance.now() - started;
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const headersMs = since();
    const reads: BodyRead[] = [];
    const decoder = new TextDecoder();
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads.push({ atMs: since(), text: decoder.decode(value, { stream: true }) });
    }
    const totalMs = since();
    const raw = reads.map((r) => r.text).join("");
    const streamed = response.status === 200 && (mode === "stream" || mode === "json-array");
    const analysis = streamed ? analyseStream(cell.format, mode === "json-array" ? jsonArrayEvents(reads) : sseEvents(reads)) : undefined;
    let text = analysis?.text ?? "";
    if (!streamed) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        text = response.status === 200 ? (mode === "count" ? `input_tokens=${String(parsed["input_tokens"])}` : bodyText(cell.format, parsed)) : raw.slice(0, 300);
      } catch {
        text = raw.slice(0, 300);
      }
    }
    return {
      cell,
      mode,
      run,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "(none)",
      dropped: response.headers.get("x-proxy-dropped") ?? "",
      requestId: REQUEST_ID_HEADERS.filter((h) => response.headers.has(h)).join(" "),
      headersMs,
      totalMs,
      analysis,
      text,
      error: "",
    };
  } catch (error) {
    return { cell, mode, run, status: 0, contentType: "", dropped: "", requestId: "", headersMs: since(), totalMs: since(), analysis: undefined, text: "", error: String(error) };
  }
}

const passed = (r: Row) =>
  r.status === 200 && (r.mode === "count" ? r.text.startsWith("input_tokens=") && r.text !== "input_tokens=undefined" : r.text.trim() !== "" && (r.analysis === undefined || r.analysis.terminal));
/** Incremental (plan §2): the answer text arrived in at least 3 separate reads, the first before the last event. */
const incremental = (a: StreamAnalysis) => a.textReads >= 3 && a.firstTokenMs !== undefined && a.lastEventMs !== undefined && a.firstTokenMs < a.lastEventMs;

const ms = (n: number | undefined) => (n === undefined ? "–" : String(Math.round(n)));
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};
const clip = (text: string, n = 80) => text.replace(/\s+/g, " ").trim().slice(0, n).replaceAll("|", "\\|");

async function run(base: string, token: string, redactor: Redactor, write: boolean): Promise<number> {
  const health = (await (await fetch(`${base}/health`)).json()) as { providers?: unknown };
  console.log(`daemon at ${base}: providers ${JSON.stringify(health.providers)}`);
  const rows: Row[] = [];
  const stopped = new Map<string, string>();
  const startedAt = new Date().toISOString();
  for (const cell of CELLS) {
    if (only.length > 0 && !only.includes(cell.id) && !only.includes(cell.provider)) continue;
    const plan: Array<[Mode, number]> = [...Array.from({ length: RUNS }, (_, i): [Mode, number] => ["stream", i + 1]), ["plain", 1]];
    if (cell.extra === "json-array") plan.push(["json-array", 1]);
    if (cell.extra === "count") plan.push(["count", 1]);
    for (const [mode, n] of plan) {
      if (stopped.has(cell.provider)) break;
      const row = await measure(base, token, cell, mode, n);
      rows.push(row);
      const a = row.analysis;
      console.log(
        `${cell.id} ${mode}#${n}: ${row.status} ${passed(row) ? "pass" : "FAIL"} headers=${ms(row.headersMs)} ttft=${ms(a?.firstTokenMs)} total=${ms(row.totalMs)} reads=${a?.textReads ?? "–"} maxGap=${ms(a?.maxGapMs)} ct=${row.contentType} ${clip(redactor.text(row.text || row.error), 60)}`,
      );
      if (row.status === 429 || row.status === 402) stopped.set(cell.provider, `${cell.id} ${mode}#${n}: HTTP ${row.status}`);
      await sleep(replay ? 50 : PACE_MS);
    }
  }
  if (!write) return rows.every(passed) ? 0 : 1;

  const cells = CELLS.filter((c) => rows.some((r) => r.cell === c));
  const summary = cells.map((cell) => {
    const mine = rows.filter((r) => r.cell === cell);
    const streams = mine.filter((r) => r.mode === "stream" && r.analysis !== undefined);
    const of = (pick: (a: StreamAnalysis) => number | undefined) => median(streams.flatMap((r) => (pick(r.analysis!) === undefined ? [] : [pick(r.analysis!)!])));
    const plain = mine.find((r) => r.mode === "plain");
    return `| ${cell.id} | \`${cell.provider}/${cell.model}\` | ${mine.filter(passed).length}/${mine.length} | ${streams.filter((r) => incremental(r.analysis!)).length}/${mine.filter((r) => r.mode === "stream").length} | ${ms(median(streams.map((r) => r.headersMs)))} | ${ms(of((a) => a.firstTokenMs))} | ${ms(median(streams.map((r) => r.totalMs)))} | ${ms(of((a) => a.textReads))} | ${ms(of((a) => a.medianGapMs))} | ${ms(of((a) => a.maxGapMs))} | ${ms(plain?.totalMs)} | ${mine.filter((r) => r.mode !== "count" && isCount(r.text, COUNT_TO)).length}/${mine.filter((r) => r.mode !== "count").length} |`;
  });
  const detail = rows.map((r) => {
    const a = r.analysis;
    return `| ${r.cell.id} | ${r.mode}#${r.run} | ${r.status} | ${passed(r) ? "pass" : "**fail**"} | ${a === undefined ? "–" : incremental(a) ? "yes" : "**no**"} | ${r.contentType} | ${r.requestId} | ${r.dropped} | ${ms(r.headersMs)} | ${ms(a?.firstEventMs)} | ${ms(a?.firstTokenMs)} | ${ms(a?.lastEventMs)} | ${ms(r.totalMs)} | ${a?.events ?? "–"} | ${a?.textReads ?? "–"} | ${ms(a?.textSpanMs)} | ${ms(a?.medianGapMs)} | ${ms(a?.maxGapMs)} | ${a === undefined ? "–" : a.terminal ? "yes" : "**no**"} | ${clip(redactor.text(r.error !== "" ? r.error : r.text))} |`;
  });
  const ts = timestamp();
  const path = `docs/reference/${ts}-p6-live-results.md`;
  writeDoc(
    { redactor },
    path,
    `# P6 live results: every native cell, timing and incremental streaming

Generated by \`scripts/evidence/live/p6-live-results.ts\` from ${startedAt} to ${new Date().toISOString()}
([plan](../plans/2026-10-17-22-59-p6-live-results-plan.md)). The daemon is the user's own \`bun run proxy serve\` at
\`${base}\`; the client is raw HTTP (\`fetch\`, body read as it arrives), so every time is what a client sees, in ms
from sending the request. Prompt: "${PROMPT}" (no \`max_tokens\` except the one Anthropic Messages requires, 1024).
${RUNS} streamed runs and one non-streamed run per cell; Gemini's JSON-array stream once; \`count_tokens\` once on the
two providers that have it. One request at a time, ${PACE_MS / 1000} s apart.

Definitions (plan §2): **pass** = HTTP 200, a non-empty answer and, when streamed, the terminal event.
**Incremental** = the answer text arrived in at least 3 separate network reads and the first one before the last
event. **TTFT** = the first event carrying answer text (thinking and tool calls excluded). **Reads** = network reads
carrying answer text; **gap** = time between two of them. "1–${COUNT_TO}" = the answer is exactly the numbers (a
property of the model, not a pass criterion).

## Summary (medians of the streamed runs)

| Cell | Model | Pass | Incremental | Headers | TTFT | Total | Reads | Median gap | Max gap | Non-streamed total | 1–${COUNT_TO} |
|---|---|---|---|---|---|---|---|---|---|---|---|
${summary.join("\n")}

${stopped.size > 0 ? `Stopped providers (429/402): ${[...stopped.values()].join("; ")}.` : "No provider answered 429 or 402."}

## Every request

| Cell | Mode | HTTP | Pass | Incremental | content-type | Request id header | x-proxy-dropped | Headers | First event | TTFT | Last event | Total | Events | Reads | Span | Median gap | Max gap | Terminal | Answer (start) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${detail.join("\n")}
`,
  );
  console.log(`wrote ${path}`);
  return 0;
}

async function main(): Promise<number> {
  if (replay) {
    const upstreams = new ReplayUpstreams();
    upstreams.start();
    const signedIn = await startSignedInDaemon(upstreams.seamEnv());
    try {
      only.push("claude", "antigravity");
      return await run(signedIn.daemon.url, signedIn.token, new Redactor(), false);
    } finally {
      await signedIn.daemon.stop();
      removeTemporary(signedIn.home.dir);
      upstreams.stop();
    }
  }
  const live = await openLive();
  for (const gateway of live.gateways) live.redactor.add(`${gateway.spec.provider}_key`, await gateway.session.optionalKey());
  const cli = join(import.meta.dir, "..", "..", "..", "apps", "proxy", "src", "main", "cli.ts");
  const token = Bun.spawnSync([process.execPath, cli, "token"], { env: process.env }).stdout.toString().trim();
  live.redactor.add("proxy_token", token);
  return run(arg("base") ?? "http://127.0.0.1:4141", token, live.redactor, true);
}

process.exit(await main());
