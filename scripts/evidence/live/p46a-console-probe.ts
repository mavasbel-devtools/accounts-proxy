// Plan P4.6 amendment A (OpenCode Console migration, decisions K1–K6): live evidence for the 2026-10-12 Console.
//   c0  keyless route map: one paid-model POST without a key per documented address form (401 = the route exists and
//       wants a key; 404/400 = no such route), and both model lists
//   c1  keyless free model (big-pickle) on the documented Chat Completions address ("free chat models can be called
//       without it", Console Inference API page)
//   c2  device authorization under the router's own client id `inference-router` (Console API page, "Device flow"),
//       and one poll before anyone approves it; the device and user codes are redacted
//   c3  GET /console/api/v2/config without a credential (documented error shape)
// Requests are 2 s apart; raw requests (no account is needed or used). Captures are redacted and secret-scanned.
// Usage: INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/p46a-console-probe.ts [--only=c0,c1,c2,c3]
import { readAll } from "@inference-router/core/domain/wire.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc } from "@inference-router/scripts/evidence/live/harness.ts";

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");
const wanted = (id: string) => only.length === 0 || only.some((o) => id.startsWith(o));

const ORIGIN = "https://opencode.ai";
const UA = "inference-router/0.1.0";
const PROMPT = "Reply with the single word OK.";
const chat = (model: string) => ({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 32 });

type Row = { readonly id: string; readonly description: string; readonly observed: string };

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const rows: Row[] = [];
  const record = async (id: string, model: string, description: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const mark = live.recorder.mark();
    const res = await live.recorder.send({
      method,
      url: `${ORIGIN}${path}`,
      headers: { "user-agent": UA, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await readAll(res.body);
    const observed = live.redactor.text(`HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    writeCapture(live, `tests/fixtures/captures/p0-live/console/${id}.json`, { id, target: "opencode", scenario: id, model, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push({ id, description: `${method} \`${path}\` — ${description}`, observed });
    console.log(`${id}: ${observed}`);
    await sleep(PACE_MS);
  };

  if (wanted("c0")) {
    await record("c0-models", "-", "Console model list", "GET", "/inference/v1/models");
    await record("c0-go-models", "-", "Go model list", "GET", "/inference/go/v1/models");
    await record("c0-openai-chat", "kimi-k2.6", "paid model, no key", "POST", "/inference/openai/v1/chat/completions", chat("kimi-k2.6"));
    await record("c0-v1-chat", "kimi-k2.6", "paid model, no key", "POST", "/inference/v1/chat/completions", chat("kimi-k2.6"));
    await record("c0-anthropic-messages", "claude-haiku-4-5", "paid model, no key", "POST", "/inference/anthropic/v1/messages", chat("claude-haiku-4-5"));
    await record("c0-openai-responses", "gpt-5.4-nano", "paid model, no key", "POST", "/inference/openai/v1/responses", { model: "gpt-5.4-nano", input: PROMPT });
    await record("c0-google", "gemini-3-flash", "paid model, no key", "POST", "/inference/google/v1beta/models/gemini-3-flash:generateContent", { contents: [{ role: "user", parts: [{ text: PROMPT }] }] });
    await record("c0-go-chat", "glm-5.3-flash", "Go model, no key", "POST", "/inference/go/v1/chat/completions", chat("glm-5.3-flash"));
  }
  if (wanted("c1")) await record("c1-free-chat", "big-pickle", "free model, no key", "POST", "/inference/openai/v1/chat/completions", chat("big-pickle"));

  if (wanted("c2")) {
    // The codes are redacted before anything is written (they authorize a sign-in for 10 minutes).
    const mark = live.recorder.mark();
    const form = (fields: Record<string, string>) => ({
      method: "POST" as const,
      headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
    });
    const code = await live.recorder.send({ ...form({ client_id: "inference-router", supports_org_scope: "true" }), url: `${ORIGIN}/console/auth/device/code` });
    const body = JSON.parse(await readAll(code.body)) as Record<string, unknown>;
    live.redactor.add("device_code", String(body["device_code"]));
    live.redactor.add("user_code", String(body["user_code"]));
    await sleep(Number(body["interval"]) * 1000);
    const poll = await live.recorder.send({ ...form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: String(body["device_code"]), client_id: "inference-router" }), url: `${ORIGIN}/console/auth/device/token` });
    const pollText = await readAll(poll.body);
    writeCapture(live, "tests/fixtures/captures/p0-live/console/c2-device-flow.json", { id: "c2-device-flow", target: "opencode", scenario: "c2-device-flow", model: "-", capturedAt, exchanges: live.recorder.since(mark) });
    const observed = live.redactor.text(`HTTP ${code.status}; fields ${Object.keys(body).sort().join(", ")}; verification_uri_complete ${String(body["verification_uri_complete"])}; expires_in ${String(body["expires_in"])}; interval ${String(body["interval"])}; first poll after one interval: HTTP ${poll.status} ${pollText}`);
    rows.push({ id: "c2-device-flow", description: "POST `/console/auth/device/code` (client_id=inference-router, supports_org_scope=true; form-encoded), then one poll of `/console/auth/device/token`", observed });
    console.log(`c2-device-flow: ${observed}`);
    await sleep(PACE_MS);
  }
  if (wanted("c3")) await record("c3-config-unauthenticated", "-", "workspace config without a credential", "GET", "/console/api/v2/config");

  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-p46a-console-live-probe.md`,
    `# P4.6 amendment A — OpenCode Console live probe

Generated by \`scripts/evidence/live/p46a-console-probe.ts\` on ${capturedAt}
([plan P4.6 amendment A](../plans/2026-10-12-15-35-p46-gateway-providers-plan.md),
[rules](2026-10-12-15-35-gateway-provider-rules.md) §3a). Raw keyless requests with \`User-Agent: ${UA}\`; captures in
\`tests/fixtures/captures/p0-live/console/<id>.json\` (redacted, secret-scanned; c2's codes redacted).

| Probe | Request | Observed |
|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.description} | ${r.observed.replaceAll("|", "\\|")} |`).join("\n")}
`,
  );
  console.log(`wrote docs/reference/${ts}-p46a-console-live-probe.md`);
  return 0;
}

process.exit(await main());
