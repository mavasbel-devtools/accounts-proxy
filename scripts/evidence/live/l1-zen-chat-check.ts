// Live validation L1 follow-up (docs/plans/2026-10-13-01-42-live-validation-plan.md): OpenCode Zen answered 404
// "Upstream request failed: Endpoint is unavailable." for deepseek-v4-flash on /inference/openai/v1/chat/completions.
// Three requests decide whether the path, the model or the account is the cause:
//   z1 the same model on models.dev's api base (/inference/v1/chat/completions)
//   z2 Chat Completions models the Console docs name (kimi-k2.6, glm-5.1) on the documented path
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/l1-zen-chat-check.ts
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { PACE_MS, openLive, sleep, writeCapture } from "@accounts-proxy/scripts/evidence/live/harness.ts";

const live = await openLive();
const zen = live.gateways.find((g) => g.spec.provider === "opencode");
if (zen?.console === undefined) throw new Error("opencode is not enabled");
const active = await zen.console.session.active();
const credential = active.account;
if (credential.kind !== "device") throw new Error("this check expects the Console device sign-in");
const accessToken = credential.tokens.accessToken;
live.redactor.add("opencode_access", accessToken);
const capturedAt = new Date().toISOString();
const body = (model: string) => JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }] });
for (const [id, url, model] of [
  ["z1-models-dev-base", "https://opencode.ai/inference/v1/chat/completions", "deepseek-v4-flash"],
  ["z2-kimi-k2.6", "https://opencode.ai/inference/openai/v1/chat/completions", "kimi-k2.6"],
  ["z2-glm-5.1", "https://opencode.ai/inference/openai/v1/chat/completions", "glm-5.1"],
] as const) {
  const mark = live.recorder.mark();
  const res = await live.recorder.send({ method: "POST", url, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": "accounts-proxy/0.1.0", "x-opencode-session": `ses_l1_${capturedAt}`, ...credential.headers.opencode }, body: body(model) });
  const text = await readAll(res.body);
  writeCapture(live, `tests/fixtures/captures/p0-live/l1/opencode-${id}.json`, { id, target: "opencode", scenario: id, model, capturedAt, exchanges: live.recorder.since(mark) });
  console.log(`${id} ${model}: HTTP ${res.status} ${live.redactor.text(text).replace(/\s+/g, " ").slice(0, 300)}`);
  await sleep(PACE_MS);
}
