// Live media probe M1 (initiative "multimedia support evidence", 2026-10-24): which media each provider carries through
// the proxy, measured, not assumed.
//   Part D (daemon): the production daemon in this process (recording transport) answers the official SDKs. Each probe
//     sends one medium the model's list claims (image, PDF, audio, video, inline or by URL) with a question only the
//     medium answers (a PNG, a PDF, a spoken WAV and a VP9 WebM carrying the code word → "PELICAN"; a URL photo of an
//     ant → "ant"; the W3C dummy PDF by URL → "dummy"), Antigravity's media settings (fileData, image output,
//     mediaResolution), and the Anthropic Files API (upload route, file_id source with its beta) to record the answer.
//   Part U (upstream): the Antigravity features the proxy refuses, sent straight to Cloud Code Assist through the
//     production API client (harness.antigravityGenerate), to learn whether the upstream accepts them.
// Verdicts: ACCEPTED (200 and the answer names the expected word / the image came back), IGNORED (200 without it),
// REFUSED (non-200; the status and message are recorded). One request at a time, 2 s apart; a 429/402 stops that
// provider (no retry, no rotation). Captures (redacted, secret-scanned): tests/fixtures/captures/p0-live/m1/<id>.json;
// the table: docs/reference/<ts>-m1-media-probe.md.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/m1-media-probe.ts [--only=<cell|probe-id>,...] [--no-doc]
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { GoogleGenAI, type GenerateContentResponse, type Part } from "@google/genai";
import { codeWordPdf } from "@accounts-proxy/scripts/evidence/live/e3-fidelity.ts";
import { startDaemon } from "@accounts-proxy/scripts/evidence/live/daemon.ts";
import { antigravityGenerate, antigravityModel, openLive, PACE_MS, sleep, StopRun, timestamp, writeCapture, writeDoc, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";
import type { Exchange } from "@accounts-proxy/scripts/evidence/live/recording-transport.ts";
import { AUDIO_FILE, IMAGE_FILE, MEDIA_CODE_WORD, mediaBytes, VIDEO_FILE } from "@accounts-proxy/scripts/evidence/media-fixtures.ts";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const writeTable = !process.argv.includes("--no-doc");

// ---------------------------------------------------------------- media

const PNG = Buffer.from(mediaBytes(IMAGE_FILE)).toString("base64");
const PDF = codeWordPdf();
const WAV = Buffer.from(mediaBytes(AUDIO_FILE)).toString("base64");
const WEBM = Buffer.from(mediaBytes(VIDEO_FILE)).toString("base64");
/** Public files, fetched by the upstream (checked 2026-10-24: 200 image/jpeg 758559 bytes; 200 application/pdf 13264 bytes). */
const ANT_JPG_URL = "https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg";
const DUMMY_PDF_URL = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

type Medium = { readonly name: string; readonly prompt: string; readonly expect: RegExp };
const IMAGE: Medium = { name: "image (PNG, inline)", prompt: "What word is written in this image? Reply with the word only.", expect: new RegExp(MEDIA_CODE_WORD, "i") };
const PDF_DOC: Medium = { name: "PDF (inline)", prompt: "What is the code word in the document? Reply with the word only.", expect: new RegExp(MEDIA_CODE_WORD, "i") };
const AUDIO: Medium = { name: "audio (WAV, inline)", prompt: "What code word is spoken in this audio? Reply with the word only.", expect: new RegExp(MEDIA_CODE_WORD, "i") };
const VIDEO: Medium = { name: "video (WebM VP9, inline)", prompt: "What word is written in this video? Reply with the word only.", expect: new RegExp(MEDIA_CODE_WORD, "i") };
const IMAGE_URL: Medium = { name: "image (JPEG, by URL)", prompt: "What kind of insect is in this photo? One word.", expect: /\bants?\b/i };
const PDF_URL: Medium = { name: "PDF (by URL)", prompt: "Quote the text of this PDF.", expect: /dummy/i };
const IMAGE_OUT: Medium = { name: "image output", prompt: "Draw a small red circle on a white background.", expect: /./ };

// ---------------------------------------------------------------- bookkeeping

type Verdict = "ACCEPTED" | "IGNORED" | "REFUSED";
type Outcome = { readonly status: number; readonly verdict: Verdict; readonly evidence: string; readonly dropped?: string | null };
type Row = { readonly part: "D" | "U"; readonly id: string; readonly capture: string; readonly provider: string; readonly format: string; readonly model: string; readonly medium: string; readonly outcome: Outcome; readonly upstream: string; readonly ms: number };

const clip = (text: string, n = 160) => text.replace(/\s+/g, " ").trim().slice(0, n);
const judged = (medium: Medium, text: string, extra = ""): Outcome => ({ status: 200, verdict: medium.expect.test(text) ? "ACCEPTED" : "IGNORED", evidence: `answer=${JSON.stringify(clip(text))}${extra}` });

/** SDK errors (all three SDKs) carry the HTTP status and the server's message. */
function failed(error: unknown): Outcome {
  const e = error as { status?: unknown; message?: unknown };
  if (typeof e.status === "number") return { status: e.status, verdict: "REFUSED", evidence: clip(String(e.message), 400) };
  throw error;
}

type Probe = { readonly id: string; readonly provider: string; readonly format: string; readonly model: string; readonly medium: Medium; readonly run: () => Promise<Outcome> };

// ---------------------------------------------------------------- the client dialects

function anthropic(base: string, token: string) {
  const client = new Anthropic({ apiKey: token, baseURL: `${base}/anthropic`, maxRetries: 0, timeout: 180_000 });
  const ask = async (model: string, medium: Medium, block: Anthropic.ContentBlockParam): Promise<Outcome> => {
    const { data, response } = await client.messages.create({ model, max_tokens: 512, messages: [{ role: "user", content: [block, { type: "text", text: medium.prompt }] }] }).withResponse();
    const text = data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { ...judged(medium, text, ` stop=${data.stop_reason} input_tokens=${data.usage.input_tokens}`), dropped: response.headers.get("x-proxy-dropped") };
  };
  return {
    image: (model: string) => ask(model, IMAGE, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }),
    pdf: (model: string) => ask(model, PDF_DOC, { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } }),
    imageUrl: (model: string) => ask(model, IMAGE_URL, { type: "image", source: { type: "url", url: ANT_JPG_URL } }),
    pdfUrl: (model: string) => ask(model, PDF_URL, { type: "document", source: { type: "url", url: DUMMY_PDF_URL } }),
    /** A Files API source needs the files beta; the id is a placeholder (no upload route exists to make a real one). */
    async fileId(model: string): Promise<Outcome> {
      const { data } = await client.messages
        .create({ model, max_tokens: 512, messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_m1_probe_placeholder" } } as unknown as Anthropic.ContentBlockParam, { type: "text", text: PDF_DOC.prompt }] }] }, { headers: { "anthropic-beta": "files-api-2025-04-14" } })
        .withResponse();
      const text = data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return judged(PDF_DOC, text);
    },
  };
}

function responses(base: string, token: string) {
  const client = new OpenAI({ apiKey: token, baseURL: `${base}/openai/v1`, maxRetries: 0, timeout: 180_000 });
  const ask = async (model: string, medium: Medium, part: OpenAI.Responses.ResponseInputContent): Promise<Outcome> => {
    const { data, response } = await client.responses.create({ model, input: [{ role: "user", content: [part, { type: "input_text", text: medium.prompt }] }] }).withResponse();
    return { ...judged(medium, data.output_text, ` status=${data.status} input_tokens=${data.usage?.input_tokens}`), dropped: response.headers.get("x-proxy-dropped") };
  };
  return {
    image: (model: string) => ask(model, IMAGE, { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" }),
    pdf: (model: string) => ask(model, PDF_DOC, { type: "input_file", filename: "code-word.pdf", file_data: `data:application/pdf;base64,${PDF}` }),
    imageUrl: (model: string) => ask(model, IMAGE_URL, { type: "input_image", image_url: ANT_JPG_URL, detail: "auto" }),
    pdfUrl: (model: string) => ask(model, PDF_URL, { type: "input_file", file_url: DUMMY_PDF_URL }),
  };
}

function chat(base: string, token: string) {
  const client = new OpenAI({ apiKey: token, baseURL: `${base}/openai/v1`, maxRetries: 0, timeout: 180_000 });
  const ask = async (model: string, medium: Medium, part: unknown): Promise<Outcome> => {
    const content = [part, { type: "text", text: medium.prompt }] as OpenAI.ChatCompletionContentPart[];
    const { data, response } = await client.chat.completions.create({ model, messages: [{ role: "user", content }] }).withResponse();
    const choice = data.choices[0];
    return { ...judged(medium, choice?.message.content ?? "", ` finish=${choice?.finish_reason} prompt_tokens=${data.usage?.prompt_tokens}`), dropped: response.headers.get("x-proxy-dropped") };
  };
  return {
    image: (model: string) => ask(model, IMAGE, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }),
    pdf: (model: string) => ask(model, PDF_DOC, { type: "file", file: { filename: "code-word.pdf", file_data: `data:application/pdf;base64,${PDF}` } }),
    audio: (model: string) => ask(model, AUDIO, { type: "input_audio", input_audio: { data: WAV, format: "wav" } }),
    video: (model: string) => ask(model, VIDEO, { type: "video_url", video_url: { url: `data:video/webm;base64,${WEBM}` } }),
  };
}

function gemini(base: string, token: string, generated: (parts: readonly Part[]) => void) {
  const client = new GoogleGenAI({ apiKey: token, httpOptions: { baseUrl: `${base}/gemini`, timeout: 180_000 } });
  const ask = async (model: string, medium: Medium, part: Part, config: Record<string, unknown> = {}): Promise<Outcome> => {
    const r: GenerateContentResponse = await client.models.generateContent({ model, contents: [{ role: "user", parts: [part, { text: medium.prompt }] }], config });
    const dropped = r.sdkHttpResponse?.headers?.["x-proxy-dropped"] ?? null;
    return { ...judged(medium, r.text ?? "", ` finish=${r.candidates?.[0]?.finishReason} prompt_tokens=${r.usageMetadata?.promptTokenCount}`), dropped };
  };
  const inline = (mimeType: string, data: string): Part => ({ inlineData: { mimeType, data } });
  return {
    image: (model: string) => ask(model, IMAGE, inline("image/png", PNG)),
    pdf: (model: string) => ask(model, PDF_DOC, inline("application/pdf", PDF)),
    audio: (model: string) => ask(model, AUDIO, inline("audio/wav", WAV)),
    video: (model: string) => ask(model, VIDEO, inline("video/webm", WEBM)),
    pdfUrl: (model: string) => ask(model, PDF_URL, { fileData: { mimeType: "application/pdf", fileUri: DUMMY_PDF_URL } }),
    lowResolution: (model: string) => ask(model, IMAGE, inline("image/png", PNG), { mediaResolution: "MEDIA_RESOLUTION_LOW" }),
    async imageOut(model: string): Promise<Outcome> {
      const r = await client.models.generateContent({ model, contents: IMAGE_OUT.prompt, config: { responseModalities: ["TEXT", "IMAGE"] } });
      const images = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData?.mimeType?.startsWith("image/") === true);
      generated(r.candidates?.[0]?.content?.parts ?? []);
      return { status: 200, verdict: images.length > 0 ? "ACCEPTED" : "IGNORED", evidence: `images=${images.map((p) => `${p.inlineData?.mimeType}:${p.inlineData?.data?.length ?? 0}b64`).join(",") || "none"} text=${JSON.stringify(clip(r.text ?? ""))}` };
    },
  };
}

/** The Anthropic Files API path: the proxy has no route for it (every other /anthropic/v1 path goes to a model's provider). */
async function filesUpload(base: string, token: string): Promise<Outcome> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(PDF, "base64")], { type: "application/pdf" }), "code-word.pdf");
  const response = await fetch(`${base}/anthropic/v1/files`, { method: "POST", headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "anthropic-beta": "files-api-2025-04-14" }, body: form });
  const text = await response.text();
  return { status: response.status, verdict: response.status === 200 ? "ACCEPTED" : "REFUSED", evidence: clip(text, 400) };
}

/**
 * A generated image, and the thought signature that comes with it (≈1 MB of base64 on gemini-3.1-flash-image), are
 * named in the capture by kind, size and sha256: random base64 of that size contains token prefixes such as `1//` by
 * chance, which the secret scan refuses.
 */
function registerOpaque(live: Live, kind: "generated-image" | "thought-signature", data: string): void {
  if (data.length < 6) return;
  live.redactor.fixture(`${kind} ${data.length} base64 chars sha256:${createHash("sha256").update(data).digest("hex")}`, data);
}

function registerImageParts(live: Live, parts: ReadonlyArray<{ readonly inlineData?: { readonly mimeType?: string; readonly data?: string }; readonly thoughtSignature?: string }>): number {
  let images = 0;
  for (const part of parts) {
    if (part.inlineData?.mimeType?.startsWith("image/") === true) {
      images++;
      registerOpaque(live, "generated-image", part.inlineData.data ?? "");
    }
    if (part.thoughtSignature !== undefined) registerOpaque(live, "thought-signature", part.thoughtSignature);
  }
  return images;
}

/** The exchanges with each response's chunks joined into one (keeps every byte; loses only the per-chunk timing). */
function joinedChunks(exchanges: readonly Exchange[]): Exchange[] {
  return exchanges.map((e) => ({ ...e, chunks: e.chunks.length <= 1 ? e.chunks : [{ atMs: e.chunks[e.chunks.length - 1]!.atMs, text: e.chunks.map((c) => c.text).join("") }] }));
}

// ---------------------------------------------------------------- part U: Antigravity upstream, no proxy rules

type Upstream = { readonly id: string; readonly model: string; readonly medium: Medium; readonly parts: readonly Record<string, unknown>[]; readonly generation?: Record<string, unknown>; readonly judge: (text: string, images: number) => Verdict };

const UPSTREAM: readonly Upstream[] = [
  { id: "u1-filedata-image-url", model: "gemini-3.5-flash-lite", medium: IMAGE_URL, parts: [{ fileData: { mimeType: "image/jpeg", fileUri: ANT_JPG_URL } }], judge: (t) => (IMAGE_URL.expect.test(t) ? "ACCEPTED" : "IGNORED") },
  { id: "u2-filedata-pdf-url", model: "gemini-3.5-flash-lite", medium: PDF_URL, parts: [{ fileData: { mimeType: "application/pdf", fileUri: DUMMY_PDF_URL } }], judge: (t) => (PDF_URL.expect.test(t) ? "ACCEPTED" : "IGNORED") },
  { id: "u3-image-output", model: "gemini-3.1-flash-image", medium: IMAGE_OUT, parts: [], generation: { responseModalities: ["TEXT", "IMAGE"] }, judge: (_t, images) => (images > 0 ? "ACCEPTED" : "IGNORED") },
  { id: "u4-media-resolution-low", model: "gemini-3.5-flash-lite", medium: IMAGE, parts: [{ inlineData: { mimeType: "image/png", data: PNG } }], generation: { mediaResolution: "MEDIA_RESOLUTION_LOW" }, judge: (t) => (IMAGE.expect.test(t) ? "ACCEPTED" : "IGNORED") },
  { id: "u5-media-resolution-medium", model: "gemini-3.5-flash-lite", medium: IMAGE, parts: [{ inlineData: { mimeType: "image/png", data: PNG } }], generation: { mediaResolution: "MEDIA_RESOLUTION_MEDIUM" }, judge: (t) => (IMAGE.expect.test(t) ? "ACCEPTED" : "IGNORED") },
  { id: "u6-media-resolution-high", model: "gemini-3.5-flash-lite", medium: IMAGE, parts: [{ inlineData: { mimeType: "image/png", data: PNG } }], generation: { mediaResolution: "MEDIA_RESOLUTION_HIGH" }, judge: (t) => (IMAGE.expect.test(t) ? "ACCEPTED" : "IGNORED") },
];

async function upstreamProbe(live: Live, probe: Upstream): Promise<Outcome> {
  const model = await antigravityModel(live, probe.model);
  const text = probe.medium.prompt;
  const r = await antigravityGenerate(live, model, [{ role: "user", text }], (s) => ({
    contents: [{ role: "user", parts: [...probe.parts, { text }] }],
    labels: s.labels,
    generationConfig: { maxOutputTokens: 2048, ...(probe.generation ?? {}) },
    sessionId: s.sessionId,
  }));
  if (!r.ok) return { status: r.status ?? 0, verdict: "REFUSED", evidence: clip(String(r.error), 400) };
  const parts = r.envelopes.flatMap((e) => e.response?.candidates?.[0]?.content?.parts ?? []) as Array<Record<string, unknown>>;
  const answer = parts.filter((p) => p["thought"] !== true && typeof p["text"] === "string").map((p) => p["text"] as string).join("");
  const images = registerImageParts(live, parts as Parameters<typeof registerImageParts>[1]);
  return { status: 200, verdict: probe.judge(answer, images), evidence: `answer=${JSON.stringify(clip(answer))}${images > 0 ? ` images=${images}` : ""}` };
}

// ---------------------------------------------------------------- run

async function main(): Promise<number> {
  const live = await openLive();
  // The committed media are named in the captures, not repeated (and their base64 cannot trip the prefix scan).
  live.redactor.fixture(IMAGE_FILE, PNG);
  live.redactor.fixture("code-word.pdf", PDF);
  live.redactor.fixture(AUDIO_FILE, WAV);
  live.redactor.fixture(VIDEO_FILE, WEBM);
  const daemon = await startDaemon(live);
  const { base, token } = daemon;
  const capturedAt = new Date().toISOString();
  const a = anthropic(base, token);
  const r = responses(base, token);
  const c = chat(base, token);
  const g = gemini(base, token, (parts) => void registerImageParts(live, parts));

  const p = (id: string, provider: string, format: string, model: string, medium: Medium, run: (routable: string) => Promise<Outcome>): Probe => ({ id, provider, format, model, medium, run: () => run(`${provider}/${model}`) });
  const PROBES: readonly Probe[] = [
    p("claude-image", "claude", "Messages", "claude-haiku-4-5-20251001", IMAGE, a.image),
    p("claude-pdf", "claude", "Messages", "claude-haiku-4-5-20251001", PDF_DOC, a.pdf),
    p("claude-image-url", "claude", "Messages", "claude-haiku-4-5-20251001", IMAGE_URL, a.imageUrl),
    p("claude-pdf-url", "claude", "Messages", "claude-haiku-4-5-20251001", PDF_URL, a.pdfUrl),
    { id: "claude-files-api", provider: "claude", format: "Messages", model: "-", medium: { name: "Files API upload (POST /anthropic/v1/files)", prompt: "", expect: /./ }, run: () => filesUpload(base, token) },
    p("claude-file-id", "claude", "Messages", "claude-haiku-4-5-20251001", { ...PDF_DOC, name: "PDF (Files API file_id, files beta)" }, a.fileId),
    p("antigravity-image", "antigravity", "Gemini", "gemini-3.5-flash-lite", IMAGE, g.image),
    p("antigravity-pdf", "antigravity", "Gemini", "gemini-3.5-flash-lite", PDF_DOC, g.pdf),
    p("antigravity-audio", "antigravity", "Gemini", "gemini-3.5-flash-lite", AUDIO, g.audio),
    p("antigravity-video", "antigravity", "Gemini", "gemini-3.5-flash-lite", VIDEO, g.video),
    p("antigravity-filedata-pdf-url", "antigravity", "Gemini", "gemini-3.5-flash-lite", PDF_URL, g.pdfUrl),
    p("antigravity-media-resolution", "antigravity", "Gemini", "gemini-3.5-flash-lite", IMAGE, g.lowResolution),
    p("antigravity-image-out", "antigravity", "Gemini", "gemini-3.1-flash-image", IMAGE_OUT, g.imageOut),
    p("antigravity-claude-image", "antigravity", "Gemini", "claude-sonnet-5-5-low", IMAGE, g.image),
    p("antigravity-claude-pdf", "antigravity", "Gemini", "claude-sonnet-5-5-low", PDF_DOC, g.pdf),
    p("antigravity-claude-video", "antigravity", "Gemini", "claude-sonnet-5-5-low", VIDEO, g.video),
    p("openai-image", "openai", "Responses", "gpt-5.6-luna", IMAGE, r.image),
    p("openai-pdf", "openai", "Responses", "gpt-5.6-luna", PDF_DOC, r.pdf),
    p("openai-image-url", "openai", "Responses", "gpt-5.6-luna", IMAGE_URL, r.imageUrl),
    p("openai-pdf-url", "openai", "Responses", "gpt-5.6-luna", PDF_URL, r.pdfUrl),
    p("openrouter-image", "openrouter", "Chat", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", IMAGE, c.image),
    p("openrouter-pdf", "openrouter", "Chat", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", PDF_DOC, c.pdf),
    p("openrouter-audio", "openrouter", "Chat", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", AUDIO, c.audio),
    p("openrouter-video", "openrouter", "Chat", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", VIDEO, c.video),
    p("opencode-gem-image", "opencode", "Gemini", "gemini-3.5-flash-lite", IMAGE, g.image),
    p("opencode-gem-pdf", "opencode", "Gemini", "gemini-3.5-flash-lite", PDF_DOC, g.pdf),
    p("opencode-gem-audio", "opencode", "Gemini", "gemini-3.5-flash-lite", AUDIO, g.audio),
    p("opencode-gem-video", "opencode", "Gemini", "gemini-3.5-flash-lite", VIDEO, g.video),
    p("opencode-chat-image", "opencode", "Chat", "glm-5.3-flash", IMAGE, c.image),
    p("go-chat-image", "opencode-go", "Chat", "glm-5.3-flash", IMAGE, c.image),
    p("go-chat-video", "opencode-go", "Chat", "glm-5.3-flash", VIDEO, c.video),
    p("cheaper-chat-image", "cheaper-inference", "Chat", "gpt-5.4-nano", IMAGE, c.image),
    p("cheaper-resp-image", "cheaper-inference", "Responses", "gpt-5.4-nano", IMAGE, r.image),
  ];

  const rows: Row[] = [];
  const stopped = new Map<string, string>();
  const wanted = (id: string, provider: string) => only.length === 0 || only.includes(id) || only.includes(provider);
  const step = async (part: "D" | "U", id: string, provider: string, format: string, model: string, medium: Medium, run: () => Promise<Outcome>) => {
    if (!wanted(id, provider) || stopped.has(provider)) return;
    const mark = live.recorder.mark();
    const started = performance.now();
    let outcome: Outcome;
    try {
      outcome = await run().catch(failed);
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
      outcome = { status: 429, verdict: "REFUSED", evidence: error.message };
    }
    const exchanges = live.recorder.since(mark);
    let capture = `m1/${id}.json`;
    const record = { id, target: provider, scenario: medium.name, model, capturedAt, exchanges };
    try {
      writeCapture(live, `tests/fixtures/captures/p0-live/m1/${id}.json`, record);
    } catch {
      // A generated payload split across response chunks escapes the per-chunk substitution: the chunks are joined.
      try {
        writeCapture(live, `tests/fixtures/captures/p0-live/m1/${id}.json`, { ...record, exchanges: joinedChunks(exchanges), note: "response chunks joined: a generated image spans several chunks" });
        capture = `m1/${id}.json (chunks joined)`;
      } catch {
        // The secret scan refused the file again: nothing was written; the row says so instead of the run stopping.
        capture = "not written (the secret scan refused it)";
      }
    }
    const upstream = exchanges.map((e) => `${e.status ?? "-"} ${new URL(e.request.url).pathname.split("/").slice(-1)[0]}`).join(", ");
    const row: Row = { part, id, capture, provider, format, model, medium: medium.name, outcome: { ...outcome, evidence: live.redactor.text(outcome.evidence) }, upstream, ms: Math.round(performance.now() - started) };
    rows.push(row);
    console.log(`${id}: ${outcome.status} ${outcome.verdict} ${row.outcome.evidence}${outcome.dropped ? ` dropped=${outcome.dropped}` : ""} [upstream ${upstream || "none"}] capture ${capture}`);
    if (outcome.status === 429 || outcome.status === 402) stopped.set(provider, `${id}: HTTP ${outcome.status}`);
    await sleep(PACE_MS);
  };

  for (const probe of PROBES) await step("D", probe.id, probe.provider, probe.format, probe.model, probe.medium, probe.run);
  for (const probe of UPSTREAM) await step("U", probe.id, "antigravity", "Gemini (upstream, no proxy rules)", probe.model, probe.medium, () => upstreamProbe(live, probe));

  const { code, output } = await daemon.stop();
  if (!writeTable) return 0;
  const ts = timestamp();
  const table = (part: "D" | "U") =>
    rows
      .filter((row) => row.part === part)
      .map((row) => `| ${row.id} | \`${row.provider}\` | ${row.format} | ${row.model} | ${row.medium} | ${row.outcome.status} | ${row.outcome.verdict} | ${row.outcome.evidence.replaceAll("|", "\\|")} | ${row.outcome.dropped ?? ""} | ${row.upstream || "none"} | ${row.capture} | ${row.ms} |`)
      .join("\n");
  writeDoc(
    live,
    `docs/reference/${ts}-m1-media-probe.md`,
    `# Live media probe M1: images, PDFs, audio and video through every provider

Generated by \`scripts/evidence/live/m1-media-probe.ts\` on ${capturedAt}. Part D: the production daemon
(\`runCli(["serve"])\`) in the script's process over the recording transport, called with the official SDKs
(@anthropic-ai/sdk, openai, @google/genai) on the proxy's routes and token. Part U: the Antigravity features the proxy
refuses, sent straight to Cloud Code Assist by the production API client (no proxy request rules). Captures:
\`tests/fixtures/captures/p0-live/m1/<id>.json\` (redacted, secret-scanned; token-endpoint exchanges omitted; the
committed media appear as \`<FIXTURE:name>\` instead of their base64).
Daemon exit: ${code}.

Media: a one-page PDF built in code (\`codeWordPdf\` in e3-fidelity.ts) and a PNG, a spoken WAV and a VP9 WebM
(\`tests/fixtures/media/\`, made by \`scripts/evidence/media-fixtures.ts\`, sizes and sha256 in its manifest), each
carrying the code word ${MEDIA_CODE_WORD}; by URL: ${ANT_JPG_URL} and ${DUMMY_PDF_URL}.
ACCEPTED: 200 and the answer names what only the medium shows (or an image came back); IGNORED: 200 without it;
REFUSED: the status and message the client got.

## Part D: through the daemon

| Probe | Provider | Format | Model | Medium | HTTP | Verdict | Evidence | x-proxy-dropped | Upstream calls | Capture | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
${table("D")}

## Part U: Antigravity upstream, without the proxy's request rules

| Probe | Provider | Format | Model | Medium | HTTP | Verdict | Evidence | x-proxy-dropped | Upstream calls | Capture | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
${table("U")}

${stopped.size > 0 ? `Stopped providers (429/402): ${[...stopped.values()].join("; ")}.\n` : "No provider answered 429 or 402.\n"}
Daemon output:
\`\`\`
${live.redactor.text(output).trim()}
\`\`\`
`,
  );
  console.log(`wrote docs/reference/${ts}-m1-media-probe.md`);
  return 0;
}

if (import.meta.main) process.exit(await main());
