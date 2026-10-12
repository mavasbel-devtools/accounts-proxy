// Plan v4 P4.5 step 2: the OpenAI live probe on the router's own `openai` registration (signed in with
// `bun run router login openai`). Everything goes through the production wiring (buildGraph) over the recording
// transport; captures are redacted and secret-scanned before they are written to tests/fixtures/captures/p0-live/openai/.
//   o1  GET /v1/models (M1)
//   o2  one streamed Responses request (I1–I2), plain text
//   o3  a function-tool request with a top-level `function` tool (open point of the rules document)
//   o4  each documented unsupported field once, store: true, a system-role input item, one hosted tool (I3–I4)
//   o5  one refresh through the session (T3) and one reuse of the previous refresh token (T4); token bodies are never
//       written, only the status and the OAuth error code
// Requests are 2 s apart; the first quota signal (HTTP 429 or a usage-limit code) stops the run.
// Usage: INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/p45-openai-probe.ts [--only=o1,o2,...]
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import { API_BASE, UNSUPPORTED_FIELDS, USER_AGENT } from "@inference-router/provider-openai/domain/constants.ts";
import { PACE_MS, isTokenEndpoint, openLive, sleep, timestamp, writeCapture, writeDoc, type Live } from "@inference-router/scripts/evidence/live/harness.ts";

const MODEL = process.env["INFERENCE_ROUTER_OPENAI_MODEL"] ?? "gpt-5.5";
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const wanted = (id: string) => only.length === 0 || only.some((o) => id.startsWith(o));

/** Benign values from openai-openapi.yaml's CreateResponse schema (`multi_agent` is not in it: an empty object). */
const FIELD_VALUES: Readonly<Record<string, unknown>> = {
  background: false,
  conversation: "conv_probe",
  max_output_tokens: 64,
  max_tool_calls: 1,
  metadata: { probe: "1" },
  moderation: { model: "omni-moderation-latest" },
  multi_agent: {},
  prompt: { id: "pmpt_probe" },
  prompt_cache_retention: "in_memory",
  safety_identifier: "probe",
  temperature: 1,
  top_logprobs: 0,
  top_p: 1,
  truncation: "disabled",
  user: "probe",
  previous_response_id: "resp_probe",
};

const OK_INPUT = [{ role: "user", content: "Reply with the single word OK." }];
const GET_TIME = { type: "function", name: "get_time", description: "Current local time in an IANA timezone.", parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"], additionalProperties: false }, strict: true };

type Row = { readonly id: string; readonly description: string; readonly observed: string };

async function send(live: Live, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const { accessToken } = (await live.openai!.session.active()).account;
  const res = await live.recorder.send({
    method,
    url: `${API_BASE}${path}`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: method === "GET" ? "application/json" : "text/event-stream",
      "user-agent": USER_AGENT,
      ...(body !== undefined ? { "content-type": "application/json", "session-id": live.openai!.identity.sessionId, "thread-id": live.openai!.identity.sessionId, "x-client-request-id": live.openai!.identity.sessionId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await readAll(res.body) };
}

/** A one-line summary of an answer: status, terminal event, output text or error code/param. */
function summary(status: number, text: string): string {
  if (status !== 200) return `HTTP ${status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`;
  const events = [...text.matchAll(/^data: (.*)$/gm)].flatMap((m) => {
    try {
      const v: unknown = JSON.parse(m[1]!);
      return isJsonObject(v) ? [v] : [];
    } catch {
      return [];
    }
  });
  const terminal = events.findLast((e) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(String(e["type"])));
  const deltas = events.filter((e) => e["type"] === "response.output_text.delta").map((e) => String(e["delta"])).join("");
  const calls = events.filter((e) => e["type"] === "response.output_item.done" && isJsonObject(e["item"]) && e["item"]["type"] === "function_call").length;
  const error = terminal?.["type"] === "error" ? JSON.stringify({ code: terminal["code"], param: terminal["param"], message: terminal["message"] }) : terminal?.["type"] === "response.failed" ? JSON.stringify((terminal["response"] as Record<string, unknown>)["error"]) : "";
  return `HTTP 200 events=${events.length} terminal=${String(terminal?.["type"] ?? "none")} text=${JSON.stringify(deltas)}${calls > 0 ? ` function_calls=${calls}` : ""}${error !== "" ? ` error=${error}` : ""}`;
}

const quota = (status: number, text: string) => status === 429 || text.includes("subscription_sharing_usage_limit_exceeded");

async function main(): Promise<number> {
  const live = await openLive();
  if (live.openai === undefined) throw new Error("enable openai in router.yaml and run `bun run router login openai` first");
  const capturedAt = new Date().toISOString();
  const rows: Row[] = [];
  const record = async (id: string, description: string, run: () => Promise<{ status: number; text: string }>) => {
    if (!wanted(id)) return false;
    const mark = live.recorder.mark();
    const { status, text } = await run();
    const observed = live.redactor.text(summary(status, text));
    writeCapture(live, `tests/fixtures/captures/p0-live/openai/${id}.json`, { id, target: "openai", scenario: id, model: MODEL, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push({ id, description, observed });
    console.log(`${id}: ${observed}`);
    await sleep(PACE_MS);
    return quota(status, text);
  };

  const probes: [string, string, () => Promise<{ status: number; text: string }>][] = [
    ["o1-models", "`GET /v1/models`", () => send(live, "GET", "/v1/models")],
    ["o2-stream-text", "streamed text (`store:false`, `stream:true`)", () => send(live, "POST", "/v1/responses", { model: MODEL, input: OK_INPUT, store: false, stream: true })],
    [
      "o3-function-tool",
      "a top-level `function` tool, `tool_choice: auto`",
      () => send(live, "POST", "/v1/responses", { model: MODEL, input: [{ role: "user", content: "What time is it in Europe/Paris? Use the tool." }], tools: [GET_TIME], tool_choice: "auto", store: false, stream: true }),
    ],
    ...UNSUPPORTED_FIELDS.map((field): [string, string, () => Promise<{ status: number; text: string }>] => [
      `o4-field-${field.replaceAll("_", "-")}`,
      `unsupported field \`${field}: ${JSON.stringify(FIELD_VALUES[field])}\``,
      () => send(live, "POST", "/v1/responses", { model: MODEL, input: OK_INPUT, store: false, stream: true, [field]: FIELD_VALUES[field] }),
    ]),
    ["o4-store-true", "`store: true`", () => send(live, "POST", "/v1/responses", { model: MODEL, input: OK_INPUT, store: true, stream: true })],
    ["o4-system-item", "an input item `{role: system}`", () => send(live, "POST", "/v1/responses", { model: MODEL, input: [{ role: "system", content: "Answer in French." }, ...OK_INPUT], store: false, stream: true })],
    ["o4-tool-image-generation", "hosted tool `image_generation`", () => send(live, "POST", "/v1/responses", { model: MODEL, input: OK_INPUT, tools: [{ type: "image_generation" }], store: false, stream: true })],
  ];
  for (const [id, description, run] of probes) {
    if (await record(id, description, run)) {
      console.log(`quota signal at ${id}: stopping`);
      break;
    }
  }

  if (wanted("o5")) {
    const session = live.openai.session;
    const s0 = await session.active();
    const mark = live.recorder.mark();
    const tokenRow = async (step: string, call: () => Promise<unknown>) => {
      const before = live.recorder.since(mark).length;
      let outcome = "ok";
      try {
        await call();
      } catch (error) {
        outcome = live.redactor.text(`${(error as Error).name}: ${(error as Error).message}`);
      }
      const exchange = live.recorder.since(mark).slice(before).filter((e) => isTokenEndpoint(e.request.url)).at(-1);
      const body = exchange?.chunks.map((c) => c.text).join("") ?? "";
      const code = /"error"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? "";
      rows.push({ id: "o5-refresh", description: step, observed: `HTTP ${exchange?.status ?? "—"} ${outcome}${code !== "" ? ` (${code})` : ""}` });
      console.log(`o5 ${step}: HTTP ${exchange?.status} ${outcome} ${code}`);
      await sleep(PACE_MS);
    };
    let s1 = s0;
    await tokenRow("renew with R0 (persisted → R1)", async () => (s1 = await session.forceRenew(s0)));
    const rotated = s1.account.refreshToken !== s0.account.refreshToken;
    rows.push({ id: "o5-refresh", description: "R1 differs from R0", observed: rotated ? "yes (rotated)" : "no" });
    if (rotated) await tokenRow("reuse R0 once (not persisted)", () => live.openai!.oauth.refresh(s0.account));
    await tokenRow("renew with the stored R1 (persisted)", () => session.forceRenew(s1));
  }

  const ts = timestamp();
  const table = rows.map((r) => `| ${r.id} | ${r.description} | ${r.observed.replaceAll("|", "\\|")} |`).join("\n");
  writeDoc(
    live,
    `docs/reference/${ts}-p45-openai-live-probe.md`,
    `# P4.5 OpenAI live probe (ChatGPT plan usage)

Generated by \`scripts/evidence/live/p45-openai-probe.ts\` on ${capturedAt} ([completion plan](../plans/2026-10-11-22-11-completion-plan.md)
§3 step 2, [rules](2026-10-11-23-08-openai-chatgpt-plan-rules.md)). Model \`${MODEL}\`, the router's own registration,
production wiring. Captures: \`tests/fixtures/captures/p0-live/openai/<id>.json\` (redacted, secret-scanned; token
bodies are never written).

| Probe | Request | Observed |
|---|---|---|
${table}
`,
  );
  console.log(`wrote docs/reference/${ts}-p45-openai-live-probe.md`);
  return 0;
}

process.exit(await main());
