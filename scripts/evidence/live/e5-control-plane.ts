// P0-LIVE E5 (R1 option B): the antigravity control-plane answers the e2e replay needs as real evidence — the live
// model catalog (Gemini, Claude and gpt-oss models with their real limits), the quota summary, loadCodeAssist and
// fetchUserInfo — captured once through the proxy's own wiring, redacted and secret-scanned.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/e5-control-plane.ts
import { openLive, PACE_MS, sleep, writeCapture } from "@accounts-proxy/scripts/evidence/live/harness.ts";

const live = await openLive();
const active = await live.antigravity.session.active();
const capturedAt = new Date().toISOString();
const calls: Array<[string, () => Promise<unknown>]> = [
  ["fetch-available-models", () => live.antigravity.api.fetchAvailableModels(active.account.tokens)],
  ["retrieve-user-quota-summary", () => live.antigravity.api.retrieveUserQuotaSummary(active.account.tokens)],
  ["load-code-assist", () => live.antigravity.api.loadCodeAssist(active.account.tokens)],
  ["fetch-user-info", () => live.antigravity.api.fetchUserInfo(active.account.tokens)],
];
for (const [name, run] of calls) {
  const before = live.recorder.exchanges.length;
  await run();
  const file = writeCapture(live, `tests/fixtures/captures/p0-live/e5/${name}.json`, {
    id: `e5-${name}`,
    target: "antigravity control plane",
    scenario: name,
    model: "-",
    capturedAt,
    exchanges: live.recorder.exchanges.slice(before),
  });
  console.log(`wrote ${file}`);
  await sleep(PACE_MS);
}
