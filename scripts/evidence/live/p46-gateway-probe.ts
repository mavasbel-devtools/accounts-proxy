// Plan P4.6 step 5: live evidence for the API-key gateways, through the production wiring (buildGraph) over the
// recording transport; captures are redacted and secret-scanned before tests/fixtures/captures/p0-live/gateways/.
//   z0  keyless OpenCode Zen (no account needed): Chat Completions for the free model big-pickle, once with the key
//       `public` (what opencode sends without a key) and once with no key (rule Z8)
//   g1  per enabled gateway with an account: the live model list through the provider's catalog
//   g2  per enabled gateway with an account: one streamed request per native format of a small model
//       (INFERENCE_ROUTER_GW_MODEL_<PROVIDER> overrides the model; the defaults are listed below)
// Requests are 2 s apart; the first 429 or 402 stops the run.
// Usage: INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/p46-gateway-probe.ts [--only=z0,g1,g2]
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { WireFormat } from "@inference-router/core/domain/models.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc } from "@inference-router/scripts/evidence/live/harness.ts";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const wanted = (id: string) => only.length === 0 || only.some((o) => id.startsWith(o));

/** Small models per gateway (free where the vendor has one); overridable per provider. */
const DEFAULT_MODEL: Readonly<Record<string, string>> = {
  openrouter: "openai/gpt-oss-20b:free",
  opencode: "big-pickle",
  "opencode-go": "glm-5.3-flash",
  "cheaper-inference": "gpt-5.4-nano",
};

const PROMPT = "Reply with the single word OK.";
const BODY: Readonly<Record<WireFormat, (model: string) => Record<string, unknown>>> = {
  "openai-chat": (model) => ({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 32, stream: true }),
  "openai-responses": (model) => ({ model, input: PROMPT, max_output_tokens: 32, stream: true }),
  "anthropic-messages": (model) => ({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 32, stream: true }),
  gemini: () => ({ contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 32 } }),
};
const PATH: Readonly<Record<WireFormat, (model: string) => string>> = {
  "openai-chat": () => "/v1/chat/completions",
  "openai-responses": () => "/v1/responses",
  "anthropic-messages": () => "/v1/messages",
  gemini: (model) => `/v1beta/models/${model}:streamGenerateContent`,
};

type Row = { readonly id: string; readonly description: string; readonly observed: string };
const stops = (status: number) => status === 429 || status === 402;

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const rows: Row[] = [];
  const record = async (id: string, model: string, description: string, run: () => Promise<{ status: number; text: string }>) => {
    const mark = live.recorder.mark();
    const { status, text } = await run();
    const observed = live.redactor.text(`HTTP ${status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    writeCapture(live, `tests/fixtures/captures/p0-live/gateways/${id}.json`, { id, target: id.split("-")[1]!, scenario: id, model, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push({ id, description, observed });
    console.log(`${id}: ${observed}`);
    await sleep(PACE_MS);
    return stops(status);
  };
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const res = await live.recorder.send({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, text: await readAll(res.body) };
  };

  if (wanted("z0")) {
    const body = { model: "big-pickle", messages: [{ role: "user", content: PROMPT }], max_tokens: 32 };
    await record("z0-opencode-keyless-public", "big-pickle", "Zen Chat Completions, `Authorization: Bearer public`", () => post("https://opencode.ai/zen/v1/chat/completions", { authorization: "Bearer public" }, body));
    await record("z0-opencode-keyless-none", "big-pickle", "Zen Chat Completions, no key", () => post("https://opencode.ai/zen/v1/chat/completions", {}, body));
  }

  for (const gateway of live.gateways) {
    const provider = gateway.spec.provider;
    if ((await gateway.session.optionalKey()) === undefined) {
      rows.push({ id: `g-${provider}`, description: "per-account probes", observed: `skipped: no ${provider} account (run \`bun run router login ${provider}\`)` });
      continue;
    }
    const model = process.env[`INFERENCE_ROUTER_GW_MODEL_${provider.replaceAll("-", "_").toUpperCase()}`] ?? DEFAULT_MODEL[provider]!;
    if (wanted("g1")) {
      const mark = live.recorder.mark();
      const listing = await gateway.catalog.listing();
      writeCapture(live, `tests/fixtures/captures/p0-live/gateways/g1-${provider}-models.json`, { id: `g1-${provider}-models`, target: provider, scenario: "models", model: "-", capturedAt, exchanges: live.recorder.since(mark) });
      rows.push({ id: `g1-${provider}-models`, description: "live model list", observed: `${listing.source}, ${listing.models.length} models` });
      await sleep(PACE_MS);
    }
    if (!wanted("g2")) continue;
    const formats = (await gateway.provider.nativeFormats(model)) ?? new Set<WireFormat>(["openai-chat"]);
    for (const format of formats) {
      const stop = await record(`g2-${provider}-${format}`, model, `${format} stream, model \`${model}\``, async () => {
        const response = await gateway.provider.passthrough(model, { format, path: PATH[format](`${provider}/${model}`), query: format === "gemini" ? { alt: "sse" } : {}, headers: { accept: "text/event-stream", ...(format === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) }, body: JSON.stringify(BODY[format](`${provider}/${model}`)), lossy: false });
        return { status: response.status, text: await readAll(response.body) };
      });
      if (stop) {
        console.log(`${provider}: quota or credit signal, stopping`);
        break;
      }
    }
  }

  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-p46-gateway-live-probe.md`,
    `# P4.6 gateway live probe

Generated by \`scripts/evidence/live/p46-gateway-probe.ts\` on ${capturedAt}
([plan P4.6](../plans/2026-10-12-15-35-p46-gateway-providers-plan.md) step 5,
[rules](2026-10-12-15-35-gateway-provider-rules.md)). Production wiring; captures in
\`tests/fixtures/captures/p0-live/gateways/<id>.json\` (redacted, secret-scanned).

| Probe | Request | Observed |
|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.description} | ${r.observed.replaceAll("|", "\\|")} |`).join("\n")}
`,
  );
  console.log(`wrote docs/reference/${ts}-p46-gateway-live-probe.md`);
  return 0;
}

process.exit(await main());
