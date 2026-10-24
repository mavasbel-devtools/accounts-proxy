// P6 finding (docs/plans/2026-10-17-22-59-p6-live-results-plan.md, P6-4): `claude` count_tokens answered 400
// "max_tokens: Extra inputs are not permitted" because the proxy sends it the whole Messages envelope. Which body does
// the subscription upstream take on /v1/messages/count_tokens? Each probe is the production envelope (transformRequest
// with the proxy's own session, identity and catalog) with exactly the stated change, through the recording transport.
// After the fix (difference F10), `c5` sends a client request through the production claude provider instead.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/p6-count-tokens-probe.ts [--only=c1,c5,...]
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { capturedBetaHeader, transformRequest, type WireRequestBody } from "@accounts-proxy/provider-claude/domain/request-transform.ts";
import { API_BASE } from "@accounts-proxy/provider-claude/domain/constants.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";
import { bodyText } from "@accounts-proxy/test-support/http-body.ts";

const MODEL = "claude-haiku-4-5-20251001";
const PATH = "/v1/messages/count_tokens";
/** The body parameters of count_tokens (docs/reference/specs/anthropic-count-tokens.md "Body parameters"). */
const SPEC_FIELDS = ["messages", "model", "cache_control", "output_config", "system", "thinking", "tool_choice", "tools"];
const GET_TIME = { name: "get_time", description: "Current local time in an IANA timezone.", input_schema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } };
const MESSAGES = [{ role: "user", content: "What time is it in Tokyo?" }];

type Wire = Record<string, unknown>;
type Variant = { id: string; description: string; body: Record<string, unknown>; edit: (wire: Wire) => Wire };

const omit = (wire: Wire, ...keys: string[]) => Object.fromEntries(Object.entries(wire).filter(([k]) => !keys.includes(k)));
const specOnly = (wire: Wire) => Object.fromEntries(Object.entries(wire).filter(([k]) => SPEC_FIELDS.includes(k)));

const VARIANTS: readonly Variant[] = [
  { id: "c1-without-max-tokens", description: "envelope without `max_tokens` (keeps `diagnostics`, `metadata`)", body: { messages: MESSAGES }, edit: (w) => omit(w, "max_tokens") },
  { id: "c2-spec-fields", description: "envelope reduced to the spec's body parameters (billing + identity system blocks kept)", body: { messages: MESSAGES, tools: [GET_TIME] }, edit: specOnly },
  {
    id: "c3-spec-fields-thinking",
    description: "as c2 with `thinking: enabled` (the clear-thinking `context_management` edit removed with the rest)",
    body: { messages: MESSAGES, tools: [GET_TIME], thinking: { type: "enabled", budget_tokens: 2048 } },
    edit: specOnly,
  },
  { id: "c4-spec-fields-no-identity", description: "as c2 without the billing and identity system blocks (is the identity needed here?)", body: { messages: MESSAGES, tools: [GET_TIME] }, edit: (w) => omit(specOnly(w), "system") },
];

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const C5 = { id: "c5-proxy-provider-after-f10", description: "a client count_tokens request (tools, thinking enabled) through the production claude provider with difference F10" };

/** c5: the provider's own passthrough, exactly as the daemon's route calls it. */
async function viaProvider(live: Live): Promise<string> {
  const body = { model: `claude/${MODEL}`, messages: MESSAGES, tools: [GET_TIME], thinking: { type: "enabled", budget_tokens: 2048 } };
  const mark = live.recorder.mark();
  const res = await live.claude.provider.passthrough(MODEL, {
    format: "anthropic-messages",
    path: PATH,
    query: {},
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    lossy: false,
    signal: new AbortController().signal,
  });
  const text = await readAll(res.body);
  const sent = live.recorder.since(mark).find((e) => e.request.url.includes(PATH));
  const keys = Object.keys(JSON.parse(bodyText(sent?.request.body)) as Wire).sort().join(",");
  return `HTTP ${res.status} keys=${keys}: ${text.slice(0, 300)}`;
}

async function send(live: Live, variant: Variant): Promise<string> {
  const tokens = (await live.claude.session.active()).account;
  const entries = await live.claude.catalog.entries();
  const lookup = (id: string) => entries.find((e) => e.id === id);
  const upstream = transformRequest(
    { body: { model: MODEL, ...variant.body } as unknown as WireRequestBody, path: PATH, betaHeader: capturedBetaHeader(MODEL, lookup) },
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
  const wire = variant.edit(JSON.parse(upstream.body) as Wire);
  const res = await live.recorder.send({ method: "POST", url: upstream.url, headers: upstream.headers, body: JSON.stringify(wire) });
  const text = await readAll(res.body);
  return `HTTP ${res.status} keys=${Object.keys(wire).sort().join(",")}: ${text.slice(0, 300)}`;
}

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const rows: string[] = [];
  const wanted = (id: string) => only.length === 0 || only.some((o) => id.startsWith(`${o}-`));
  const selected: Array<Variant | typeof C5> = [...VARIANTS.filter((v) => wanted(v.id)), ...(wanted(C5.id) ? [C5] : [])];
  for (const variant of selected) {
    const mark = live.recorder.mark();
    const observed = live.redactor.text(variant === C5 ? await viaProvider(live) : await send(live, variant as Variant));
    writeCapture(live, `tests/fixtures/captures/p0-live/p6/${variant.id}.json`, { id: variant.id, target: "claude", scenario: variant.id, model: MODEL, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push(`| ${variant.id} | ${variant.description} | ${observed.replaceAll("|", "\\|")} | \`tests/fixtures/captures/p0-live/p6/${variant.id}.json\` |`);
    console.log(`${variant.id}: ${observed}`);
    await sleep(PACE_MS);
  }
  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-p6-count-tokens-probe.md`,
    `# P6 probe: the body Claude's count_tokens takes under the subscription envelope

Generated by \`scripts/evidence/live/p6-count-tokens-probe.ts\` on ${capturedAt} for the P6 finding
([plan](../plans/2026-10-17-22-59-p6-live-results-plan.md), [results](2026-10-18-18-37-p6-live-results.md)): the proxy
sent count_tokens the whole Messages envelope and the upstream answered 400 \`max_tokens: Extra inputs are not
permitted\`. Model \`claude/${MODEL}\`, path \`${PATH}?beta=true\`, the production headers. Each request is the
production envelope (\`transformRequest\`) with only the stated change. The spec's body parameters
(\`docs/reference/specs/anthropic-count-tokens.md\`): ${SPEC_FIELDS.map((f) => `\`${f}\``).join(", ")}.

| Probe | Change from the production envelope | Observed | Capture |
|---|---|---|---|
${rows.join("\n")}
`,
  );
  console.log(`wrote docs/reference/${ts}-p6-count-tokens-probe.md`);
  return 0;
}

process.exit(await main());
