// Live validation, decision 4 (docs/plans/2026-10-13-01-42-live-validation-plan.md): the official Google Gen AI SDK
// sends every tool whose schema carries `$schema` (and every MCP tool, `mcpToGeminiTool`) as
// `functionDeclarations[].parametersJsonSchema`; the proxy's Antigravity Gemini cell refuses that field (L1 s5).
// Four direct upstream requests (production API client, trajectory, envelope) decide what Antigravity itself does:
//   j1/j2 `parametersJsonSchema` = the MCP schema as the SDK sends it, on a Gemini and on a Claude model
//   j3/j4 `parameters` = the same schema unsanitized (`$schema`, `additionalProperties`, `anyOf`, `default`)
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/l1-antigravity-json-schema.ts
import type { ChatMessage, StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { PACE_MS, antigravityGenerate, antigravityModel, openLive, sleep, writeCapture } from "@accounts-proxy/scripts/evidence/live/harness.ts";

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
const PROMPT = "Read the file /etc/hostname with the read_file tool.";

const live = await openLive();
const capturedAt = new Date().toISOString();
const summary = (envelopes: readonly StreamEnvelope[]) => {
  const parts = envelopes.flatMap((e) => e.response?.candidates?.[0]?.content?.parts ?? []) as Array<Record<string, unknown>>;
  const calls = parts.filter((p) => p["functionCall"] !== undefined).map((p) => JSON.stringify(p["functionCall"]));
  const text = parts.filter((p) => p["thought"] !== true && typeof p["text"] === "string").map((p) => p["text"]).join("");
  return `calls=${calls.join(";") || "none"} text=${JSON.stringify(String(text).slice(0, 120))}`;
};
for (const [id, wireId, field] of [
  ["j1-gemini-parametersJsonSchema", "gemini-3.5-flash-lite", "parametersJsonSchema"],
  ["j2-claude-parametersJsonSchema", "claude-sonnet-5-5-low", "parametersJsonSchema"],
  ["j3-gemini-raw-parameters", "gemini-3.5-flash-lite", "parameters"],
  ["j4-claude-raw-parameters", "claude-sonnet-5-5-low", "parameters"],
] as const) {
  const model = await antigravityModel(live, wireId);
  const mark = live.recorder.mark();
  const view: ChatMessage[] = [{ role: "user", text: PROMPT } as ChatMessage];
  const r = await antigravityGenerate(live, model, view, (s) => ({
    contents: [{ role: "user", parts: [{ text: PROMPT }] }],
    tools: [{ functionDeclarations: [{ name: "read_file", description: "Read a text file.", [field]: MCP_SCHEMA }] }],
    labels: s.labels,
    generationConfig: { maxOutputTokens: 2048, ...(model.thinkingBudget !== undefined ? { thinkingConfig: { includeThoughts: true, thinkingBudget: model.thinkingBudget } } : {}) },
    sessionId: s.sessionId,
  }));
  writeCapture(live, `tests/fixtures/captures/p0-live/l1/antigravity-${id}.json`, { id, target: "antigravity", scenario: id, model: wireId, capturedAt, exchanges: live.recorder.since(mark) });
  console.log(`${id}: ${r.ok ? `200 ${summary(r.envelopes)}` : `HTTP ${r.status} ${live.redactor.text(String(r.error)).replace(/\s+/g, " ").slice(0, 400)}`}`);
  await sleep(PACE_MS);
}
