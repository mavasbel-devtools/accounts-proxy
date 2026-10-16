// Live validation L4 (docs/plans/2026-10-13-01-42-live-validation-plan.md): the control-plane answers the e2e replays
// of the signed-in providers need, recorded through the production adapters where they are public and redacted,
// secret-scanned captures under tests/fixtures/captures/p0-live/l4/:
//   openai-models   GET https://api.openai.com/v1/models with the session's access token (the catalog's request, M1)
//   openai-jwks     GET https://auth.openai.com/.well-known/jwks.json (public signing keys, S12)
//   console-identity  GET /console/api/user and /console/api/orgs with the device token (ConsoleApiPort.identity)
//   console-config  GET /console/api/v2/config with the device token and x-org-id (ConsoleApiPort.workspaceHeaders)
//   cheaper-account GET /v1/account with the key (the key login's check, C5)
//   cheaper-balance GET /v1/account/balance with the key (`quota cheaper-inference`, C6)
// The identifying values of the identity answers (ids, e-mail addresses, names, organisation ids: console-identity,
// cheaper-account) are added to the redactor before any capture is written; the other answers are catalogues and keep
// their names. Token-endpoint answers are never recorded (they carry grants).
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/l4-control-plane.ts
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { API_BASE, ISSUER, JWKS_PATH, USER_AGENT } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { PACE_MS, openLive, sleep, writeCapture } from "@accounts-proxy/scripts/evidence/live/harness.ts";
import type { Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";

const live = await openLive();
const capturedAt = new Date().toISOString();

/** Identifying string leaves of a JSON answer join the redactor (keys named like ids, e-mails, names, labels). */
function collectIdentifying(live: Live, value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (/(^|_)id$|Id$|email|name|label|org|user|account|subject|sub$|kid/i.test(key) && value.length >= 6 && !/^https?:/.test(value)) live.redactor.add(`answer_${key.toLowerCase()}`, value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectIdentifying(live, item, key);
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) collectIdentifying(live, v, k);
}

async function record(id: string, target: string, run: () => Promise<string>, identifying = false): Promise<void> {
  const mark = live.recorder.mark();
  const observed = await run().catch((error: unknown) => `error: ${String(error)}`);
  const exchanges = live.recorder.since(mark);
  for (const e of identifying ? exchanges : []) {
    const text = e.chunks.map((c) => c.text).join("");
    try {
      collectIdentifying(live, JSON.parse(text));
    } catch {
      /* not JSON: kept as text, still scanned */
    }
  }
  writeCapture(live, `tests/fixtures/captures/p0-live/l4/${id}.json`, { id, target, scenario: id, model: "-", capturedAt, exchanges });
  console.log(`${id}: ${live.redactor.text(observed).slice(0, 300)}`);
  await sleep(PACE_MS);
}

const get = async (url: string, headers: Record<string, string>) => {
  const res = await live.recorder.send({ method: "GET", url, headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers } });
  return `HTTP ${res.status} ${(await readAll(res.body)).length} bytes`;
};

if (live.openai !== undefined) {
  const openai = live.openai;
  await record("openai-models", "openai", async () => get(`${API_BASE}/v1/models`, { authorization: `Bearer ${(await openai.session.active()).account.accessToken}` }));
  await record("openai-jwks", "openai", () => get(`${ISSUER}${JWKS_PATH}`, {}));
}

const console_ = live.gateways.find((g) => g.console !== undefined)?.console;
if (console_ !== undefined) {
  const credential = (await console_.session.active()).account;
  if (credential.kind === "device") {
    const tokens = credential.tokens;
    await record("console-identity", "opencode", async () => JSON.stringify(await console_.api.identity(tokens)), true);
    await record("console-config", "opencode", async () => JSON.stringify(await console_.api.workspaceHeaders({ kind: "user", accessToken: tokens.accessToken, orgId: tokens.orgId })));
  }
}

const cheaper = live.gateways.find((g) => g.spec.provider === "cheaper-inference");
const key = await cheaper?.session.optionalKey();
if (cheaper !== undefined && key !== undefined) {
  live.redactor.add("cheaper_key", key);
  await record("cheaper-account", "cheaper-inference", () => get(`${cheaper.spec.apiBase}/account`, { authorization: `Bearer ${key}` }), true);
  await record("cheaper-balance", "cheaper-inference", async () => (await cheaper.quota!.usage()).text);
}
