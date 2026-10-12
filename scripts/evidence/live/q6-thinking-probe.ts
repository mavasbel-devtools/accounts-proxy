// P4 decision Q6 probe (plan 2026-10-10-19-00 §7): can the Claude subscription upstream take a request with thinking
// disabled (or absent) when the clear-thinking `context_management` edit is left out? The request is the production
// envelope (transformRequest with the router's own session, identity and catalog) with exactly one change per probe,
// sent through the recording transport. Usage: INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/q6-thinking-probe.ts
import { readAll } from "@inference-router/core/domain/wire.ts";
import { capturedBetaHeader, transformRequest, type WireRequestBody } from "@inference-router/provider-claude/domain/request-transform.ts";
import { API_BASE } from "@inference-router/provider-claude/domain/constants.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc, type Live } from "@inference-router/scripts/evidence/live/harness.ts";

const MODEL = "claude-haiku-4-5-20251001";
const GET_TIME = { name: "get_time", description: "Current local time in an IANA timezone.", input_schema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } };

type Variant = { id: string; description: string; body: Record<string, unknown>; edit: (wire: Record<string, unknown>) => Record<string, unknown> };

const withoutCm = (wire: Record<string, unknown>) => {
  const { context_management: _dropped, ...rest } = wire;
  return rest;
};

const VARIANTS: readonly Variant[] = [
  {
    id: "q6a-disabled-no-context-management",
    description: "`thinking: disabled`, clear-thinking `context_management` removed",
    body: { max_tokens: 32, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Reply with the single word OK." }] },
    edit: withoutCm,
  },
  {
    id: "q6b-absent-no-context-management",
    description: "`thinking` absent, `context_management` removed",
    body: { max_tokens: 32, messages: [{ role: "user", content: "Reply with the single word OK." }] },
    edit: (wire) => {
      const { thinking: _t, ...rest } = withoutCm(wire);
      return rest;
    },
  },
  {
    id: "q6c-disabled-forced-tool-and-temperature",
    description: "`thinking: disabled` without `context_management`, plus `tool_choice: any` and `temperature: 0` (L3)",
    body: { max_tokens: 128, thinking: { type: "disabled" }, temperature: 0, tools: [GET_TIME], tool_choice: { type: "any" }, messages: [{ role: "user", content: "Say hello." }] },
    edit: withoutCm,
  },
];

async function send(live: Live, variant: Variant): Promise<string> {
  const tokens = (await live.claude.session.active()).account;
  const entries = await live.claude.catalog.entries();
  const lookup = (id: string) => entries.find((e) => e.id === id);
  const upstream = transformRequest(
    { body: { model: MODEL, stream: true, ...variant.body } as unknown as WireRequestBody, path: "/v1/messages", betaHeader: capturedBetaHeader(MODEL, lookup) },
    {
      accessToken: tokens.accessToken,
      accountUuid: tokens.accountUuid ?? "",
      deviceId: await live.claude.identity.deviceId(),
      sessionId: live.claude.identity.sessionId,
      previousMessageId: null,
      ccPromptId: live.graph.random.uuid(),
      clientRequestId: live.graph.random.uuid(),
    },
    lookup,
    API_BASE,
  );
  const wire = variant.edit(JSON.parse(upstream.body) as Record<string, unknown>);
  const res = await live.recorder.send({ method: "POST", url: upstream.url, headers: upstream.headers, body: JSON.stringify(wire) });
  const text = await readAll(res.body);
  const stop = /"stop_reason":"([a-z_]+)"/.exec(text)?.[1];
  const answer = [...text.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  const tool = /"type":"tool_use","id":"[^"]+","name":"([^"]+)"/.exec(text)?.[1];
  const thinkingBlock = text.includes('"type":"thinking"');
  return res.status === 200
    ? `HTTP 200 stop=${stop} thinkingBlock=${thinkingBlock} text=${JSON.stringify(answer)}${tool !== undefined ? ` tool=${tool}` : ""} wire.thinking=${JSON.stringify(wire["thinking"])} wire.context_management=${JSON.stringify(wire["context_management"])}`
    : `HTTP ${res.status}: ${text.slice(0, 300)}`;
}

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const rows: string[] = [];
  for (const variant of VARIANTS) {
    const mark = live.recorder.mark();
    const observed = live.redactor.text(await send(live, variant));
    writeCapture(live, `tests/fixtures/captures/p0-live/q6/${variant.id}.json`, { id: variant.id, target: "t1", scenario: variant.id, model: MODEL, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push(`| ${variant.id} | ${variant.description} | ${observed.replaceAll("|", "\\|")} | \`tests/fixtures/captures/p0-live/q6/${variant.id}.json\` |`);
    console.log(`${variant.id}: ${observed}`);
    await sleep(PACE_MS);
  }
  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-q6-thinking-probe.md`,
    `# Q6 probe: Claude with thinking disabled and no clear-thinking edit

Generated by \`scripts/evidence/live/q6-thinking-probe.ts\` on ${capturedAt} for P4 decision Q6
([plan](../plans/2026-10-10-19-00-p4-daemon-native-cells-plan.md) §7, findings L1–L3 in
[P0-LIVE findings](2026-10-10-23-17-p0-live-findings.md)). Model \`claude/${MODEL}\`. Each request is the production
envelope (\`transformRequest\` with the router's own session, identity and catalog) with only the stated change.

| Probe | Change from the production envelope | Observed | Capture |
|---|---|---|---|
${rows.join("\n")}
`,
  );
  console.log(`wrote docs/reference/${ts}-q6-thinking-probe.md`);
  return 0;
}

process.exit(await main());
