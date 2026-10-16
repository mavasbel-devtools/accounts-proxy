// P0-LIVE E4 (plan 2026-10-07-01-23 §5, completion plan v4 H-h): refresh-token rotation, on the proxy's own accounts
// only (~/.local/share/accounts-proxy; never Claude Code's or the plugins' files). Per provider:
//   1. read the stored refresh token R0 (memory only);
//   2. renew once through the production session (forceRenew), giving R1, persisted as usual;
//   3. record whether R1 differs from R0 (rotation);
//   4. if it rotated, call the token endpoint once with R0 (nothing persisted) and record the answer;
//   5. renew once more through the session with the stored R1, which shows whether reusing R0 revoked the family.
// Token-endpoint bodies carry grants: only the HTTP status and the OAuth `error` / `error_description` fields are kept.
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/e4-rotation.ts
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { Session } from "@accounts-proxy/core/ports/outbound/session.ts";
import { PACE_MS, isTokenEndpoint, openLive, sleep, timestamp, writeDoc, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";

type Step = { readonly provider: string; readonly step: string; readonly status: number | undefined; readonly outcome: string; readonly error: string };

async function tokenStep(live: Live, provider: string, step: string, call: () => Promise<unknown>): Promise<{ row: Step; ok: boolean; value: unknown }> {
  const mark = live.recorder.mark();
  let outcome = "ok";
  let value: unknown;
  let ok = true;
  try {
    value = await call();
  } catch (error) {
    ok = false;
    outcome = `${(error as Error).name}: ${live.redactor.text((error as Error).message)}`;
  }
  const exchange = live.recorder.since(mark).filter((e) => isTokenEndpoint(e.request.url)).at(-1);
  const body = exchange?.chunks.map((c) => c.text).join("") ?? "";
  let error = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (isJsonObject(parsed)) {
      const code = typeof parsed["error"] === "string" ? parsed["error"] : isJsonObject(parsed["error"]) ? String(parsed["error"]["type"] ?? "") : "";
      const description = typeof parsed["error_description"] === "string" ? parsed["error_description"] : isJsonObject(parsed["error"]) ? String(parsed["error"]["message"] ?? "") : "";
      error = [code, description].filter((x) => x !== "").join(": ");
    }
  } catch {
    error = body === "" ? "" : "(non-JSON body)";
  }
  await sleep(PACE_MS);
  return { row: { provider, step, status: exchange?.status, outcome, error }, ok, value };
}

type Probe<A> = {
  readonly provider: string;
  readonly session: { active(): Promise<Session<A>>; forceRenew(seen: Session<A>): Promise<Session<A>> };
  readonly refreshOf: (account: A) => string | undefined;
  readonly rawRefresh: (account: A) => Promise<unknown>;
};

async function probe<A>(live: Live, p: Probe<A>): Promise<{ rows: Step[]; rotated: boolean | undefined; familyAlive: boolean | undefined }> {
  const rows: Step[] = [];
  const s0 = await p.session.active();
  const r0 = p.refreshOf(s0.account);
  if (r0 === undefined) return { rows: [{ provider: p.provider, step: "stored refresh token", status: undefined, outcome: "none stored; nothing to measure", error: "" }], rotated: undefined, familyAlive: undefined };
  const first = await tokenStep(live, p.provider, "2. renew with R0 (persisted → R1)", () => p.session.forceRenew(s0));
  rows.push(first.row);
  if (!first.ok) return { rows, rotated: undefined, familyAlive: undefined };
  const s1 = first.value as Session<A>;
  const rotated = p.refreshOf(s1.account) !== r0;
  rows.push({ provider: p.provider, step: "3. R1 differs from R0", status: undefined, outcome: rotated ? "yes (rotated)" : "no (same refresh token)", error: "" });
  if (rotated) rows.push((await tokenStep(live, p.provider, "4. reuse R0 once (not persisted)", () => p.rawRefresh(s0.account))).row);
  const last = await tokenStep(live, p.provider, "5. renew with the stored R1 (persisted)", () => p.session.forceRenew(s1));
  rows.push(last.row);
  return { rows, rotated, familyAlive: last.ok };
}

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const claude = await probe(live, {
    provider: "claude",
    session: live.claude.session,
    refreshOf: (t) => t.refreshToken,
    rawRefresh: (t) => live.claude.oauth.refresh(t),
  });
  const antigravity = await probe(live, {
    provider: "antigravity",
    session: live.antigravity.session,
    refreshOf: (a) => a.tokens.refreshToken,
    rawRefresh: (a) => live.antigravity.oauth.refresh(a.tokens),
  });
  const rows = [...claude.rows, ...antigravity.rows].map((r) => `| ${r.provider} | ${r.step} | ${r.status ?? "—"} | ${r.outcome.replaceAll("|", "\\|")} | ${r.error.replaceAll("|", "\\|") || "—"} |`);
  for (const r of rows) console.log(r);
  const verdict = (name: string, v: { rotated: boolean | undefined; familyAlive: boolean | undefined }) =>
    `- **${name}:** rotation ${v.rotated === undefined ? "not measured" : v.rotated ? "yes" : "no"}; the stored token after the run ${v.familyAlive === undefined ? "was not exercised" : v.familyAlive ? "still renews" : "no longer renews (sign in again)"}.`;
  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-e4-refresh-rotation.md`,
    `# P0-LIVE E4: refresh-token rotation

Generated by \`scripts/evidence/live/e4-rotation.ts\` on ${capturedAt}
([P0-LIVE plan](../plans/2026-10-07-01-23-p0-live-gate-plan.md) §5, [completion plan](../plans/2026-10-11-22-11-completion-plan.md) H-h).
Run on the proxy's own accounts in \`~/.local/share/accounts-proxy\` only. Token-endpoint bodies carry grants, so only
the HTTP status and the OAuth \`error\` fields are recorded; no capture file is written.

| Provider | Step | HTTP | Outcome | OAuth error |
|---|---|---|---|---|
${rows.join("\n")}

${verdict("claude", claude)}
${verdict("antigravity", antigravity)}
`,
  );
  console.log(`wrote docs/reference/${ts}-e4-refresh-rotation.md`);
  return 0;
}

process.exit(await main());
