// Rule Z26 (OpenCode free tier): opencode itself gets an answer from the free `*-free` models, but the same request
// through the proxy answered 403 `FreeTierError` "OpenCode's free tier can only be used from within OpenCode". The
// starting point is opencode v2.0.32's own first request, recorded by a logging relay
// (tests/fixtures/captures/p0-live/z26/opencode-client-request.json). f1–f3 send it straight to the gateway with the
// Console sign-in and exactly the stated change (f8, f9: which User-Agents pass); f4–f7 send it through the production `opencode` / `opencode-go`
// providers, as the daemon's route calls them, after the Z26 change (the client's User-Agent is forwarded).
// Usage: ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/z26-opencode-free-tier-probe.ts [--only=f1,f4,...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { USER_AGENT } from "@accounts-proxy/provider-opencode/domain/opencode.ts";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc, type Live } from "@accounts-proxy/scripts/evidence/live/harness.ts";

const CLIENT_FILE = "tests/fixtures/captures/p0-live/z26/opencode-client-request.json";
const MODEL = "minimax-m3.1-flash-free";
const ZEN_CHAT = "https://opencode.ai/inference/openai/v1/chat/completions";
const OTHER_AGENT = "curl/8.11.1";

type ClientRequest = { readonly recordedAt: string; readonly client: string; readonly path: string; readonly headers: Record<string, string>; readonly body: string };
const client = JSON.parse(readFileSync(join(repositoryRoot, CLIENT_FILE), "utf8")) as ClientRequest;
const withoutAgent = Object.fromEntries(Object.entries(client.headers).filter(([name]) => name !== "user-agent"));
const shortBody = JSON.stringify({ model: MODEL, messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "Reply with exactly: OK" }], stream: true, stream_options: { include_usage: true } });

type Direct = { readonly kind: "direct"; readonly id: string; readonly description: string; readonly headers: Record<string, string>; readonly body: string };
type ViaProvider = { readonly kind: "provider"; readonly id: string; readonly description: string; readonly provider: ProviderId; readonly path: string; readonly headers: Record<string, string> };
type Probe = Direct | ViaProvider;

const PROBES: readonly Probe[] = [
  { kind: "direct", id: "f1-opencode-request", description: "opencode's request as it sent it (its User-Agent and headers, its body), with the Console sign-in", headers: client.headers, body: client.body },
  { kind: "direct", id: "f2-proxy-user-agent", description: `as f1 with only the User-Agent changed to the proxy's \`${USER_AGENT}\` (what the proxy sent before Z26)`, headers: { ...client.headers, "user-agent": USER_AGENT }, body: client.body },
  { kind: "direct", id: "f8-short-opencode-agent", description: "as f1 with the User-Agent `opencode/2.0.32` (name and version only)", headers: { ...client.headers, "user-agent": "opencode/2.0.32" }, body: client.body },
  { kind: "direct", id: "f9-versionless-agent", description: "as f1 with the User-Agent `opencode/x` (no version)", headers: { ...client.headers, "user-agent": "opencode/x" }, body: client.body },
  { kind: "direct", id: "f3-other-prompt", description: "as f1 (opencode's User-Agent) with a short system prompt of another client", headers: client.headers, body: shortBody },
  { kind: "provider", id: "f4-zen-client-agent", description: "opencode's request through the production `opencode` provider (Z26: its User-Agent forwarded)", provider: "opencode", path: "/openai/v1/chat/completions", headers: client.headers },
  { kind: "provider", id: "f5-zen-no-agent", description: "as f4 from a client that sends no User-Agent (the proxy's own is sent)", provider: "opencode", path: "/openai/v1/chat/completions", headers: withoutAgent },
  { kind: "provider", id: "f6-go-client-agent", description: "opencode's request through the production `opencode-go` provider (Z26: its User-Agent forwarded)", provider: "opencode-go", path: "/openai/v1/chat/completions", headers: client.headers },
  { kind: "provider", id: "f7-go-other-agent", description: `as f6 from another client (User-Agent \`${OTHER_AGENT}\`): Go takes a forwarded foreign User-Agent`, provider: "opencode-go", path: "/openai/v1/chat/completions", headers: { ...client.headers, "user-agent": OTHER_AGENT } },
];

/** Status, the answer text assembled from the Chat Completions stream (or the error body), and the sent User-Agent. */
function summary(status: number, text: string, agent: string | undefined): string {
  const pieces = text
    .split("\n")
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .map((l) => ((JSON.parse(l.slice(5)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""))
    .join("");
  const shown = status === 200 ? `answer ${JSON.stringify(pieces.trim().slice(0, 80))}` : text.replace(/\s+/g, " ").slice(0, 160);
  return `HTTP ${status}, sent user-agent \`${agent}\`: ${shown}`;
}

async function direct(live: Live, probe: Direct): Promise<string> {
  const zen = live.gateways.find((g) => g.spec.provider === "opencode");
  if (zen?.console === undefined) throw new Error("opencode is not enabled");
  const credential = (await zen.console.session.active()).account;
  if (credential.kind !== "device") throw new Error("this probe expects the Console device sign-in");
  const headers: Record<string, string> = { ...probe.headers, authorization: `Bearer ${credential.tokens.accessToken}`, ...credential.headers.opencode };
  const res = await live.recorder.send({ method: "POST", url: ZEN_CHAT, headers, body: probe.body });
  return summary(res.status, await readAll(res.body), headers["user-agent"]);
}

async function viaProvider(live: Live, probe: ViaProvider): Promise<string> {
  const gateway = live.gateways.find((g) => g.spec.provider === probe.provider);
  if (gateway === undefined) throw new Error(`${probe.provider} is not enabled`);
  const body = JSON.stringify({ ...(JSON.parse(client.body) as Record<string, unknown>), model: `${probe.provider}/${MODEL}` });
  const mark = live.recorder.mark();
  const res = await gateway.provider.passthrough(MODEL, { format: "openai-chat", path: probe.path, query: {}, headers: probe.headers, body, lossy: false, signal: new AbortController().signal });
  const text = await readAll(res.body);
  const sent = live.recorder.since(mark).find((e) => e.request.url.endsWith("/chat/completions"));
  return summary(res.status, text, sent?.request.headers["user-agent"]);
}

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((x) => x !== "");

async function main(): Promise<number> {
  const live = await openLive();
  const capturedAt = new Date().toISOString();
  const rows: string[] = [];
  for (const probe of PROBES.filter((p) => only.length === 0 || only.some((o) => p.id.startsWith(`${o}-`)))) {
    const mark = live.recorder.mark();
    const observed = live.redactor.text(probe.kind === "direct" ? await direct(live, probe) : await viaProvider(live, probe));
    const file = `tests/fixtures/captures/p0-live/z26/${probe.id}.json`;
    writeCapture(live, file, { id: probe.id, target: probe.kind === "direct" ? "opencode" : probe.provider, scenario: probe.id, model: MODEL, capturedAt, exchanges: live.recorder.since(mark) });
    rows.push(`| ${probe.id} | ${probe.description} | ${observed.replaceAll("|", "\\|")} | \`${file}\` |`);
    console.log(`${probe.id}: ${observed}`);
    await sleep(PACE_MS);
  }
  const ts = timestamp();
  writeDoc(
    live,
    `docs/reference/${ts}-z26-opencode-free-tier-probe.md`,
    `# Probe Z26: OpenCode's free models answer only OpenCode's own requests

Generated by \`scripts/evidence/live/z26-opencode-free-tier-probe.ts\` on ${capturedAt}. The finding: opencode gets
answers from OpenCode's free \`*-free\` models, the same model through the proxy answered 403 \`FreeTierError\`
"OpenCode's free tier can only be used from within OpenCode". Model \`${MODEL}\`, the Chat Completions routes, the
proxy's Console sign-in and the workspace headers on every request.

The starting point is ${client.client}, recorded on ${client.recordedAt}: its first request, as a logging relay
standing in for \`https://opencode.ai\` received it (\`${CLIENT_FILE}\`). f1–f3, f8 and f9 go straight to \`${ZEN_CHAT}\`
with only the stated change; f4–f7 go through the production providers (\`passthrough\`, as the daemon's route calls it)
with rule Z26 in place.

| Probe | Request | Observed | Capture |
|---|---|---|---|
${rows.join("\n")}
`,
  );
  console.log(`wrote docs/reference/${ts}-z26-opencode-free-tier-probe.md`);
  return 0;
}

process.exit(await main());
