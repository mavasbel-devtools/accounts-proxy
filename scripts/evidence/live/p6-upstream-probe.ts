// P6 findings (docs/plans/2026-10-17-22-59-p6-live-results-plan.md, P6-4): where a client-side measurement of the
// daemon looks unusual, the same request goes through the production provider's own `passthrough` (the code the
// daemon's route calls) over the recording transport, which times the upstream's response headers and every chunk as
// the upstream delivered it, and keeps its response headers. The capture is the upstream's own behaviour, before the
// daemon's HTTP server. With --via=proxy the probe serves the same graph in-process with the daemon's own request
// handling (`buildRoutes` and the socket server, on 127.0.0.1:4144) and sends the request there as a raw HTTP client:
// each run then has both sides of one request, the upstream's chunks and the client's network reads. Usage:
//   ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/p6-upstream-probe.ts --probe=<id> [--runs=4] [--via=proxy]
// Probes: opencode-gem-sse (opencode Gemini SSE stream), cheaper-count (cheaper-inference count_tokens headers).
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import { MAX_BODY_BYTES, NodeHttpServer } from "@accounts-proxy/proxy/adapters/inbound/http/node-http-server.ts";
import { buildRoutes, LOOPBACK_HOST } from "@accounts-proxy/proxy/composition/container.ts";
import { PACE_MS, openLive, sleep, timestamp, writeCapture, writeDoc } from "@accounts-proxy/scripts/evidence/live/harness.ts";
import { analyseStream, sseEvents } from "@accounts-proxy/scripts/evidence/live/stream-timing.ts";

const PROMPT = "Count from 1 to 40, separated by spaces. Output only the numbers.";
const REQUEST_ID_HEADERS = ["x-opencode-log-id", "x-ci-request-id"];

type Probe = {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly format: WireFormat;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
  readonly streamed: boolean;
  readonly why: string;
  /** The client's path on the proxy (--via=proxy). */
  readonly proxyPath: string;
};

const PROBES: readonly Probe[] = [
  {
    id: "opencode-gem-sse",
    provider: "opencode",
    model: "gemini-3.5-flash-lite",
    format: "gemini",
    path: "/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent",
    query: { alt: "sse" },
    body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }] },
    streamed: true,
    proxyPath: "/gemini/v1beta/models/opencode%2Fgemini-3.5-flash-lite:streamGenerateContent?alt=sse",
    why: "final run, `opencode-gem` stream#3: the answer text reached the client in 2 network reads (55 ms apart), below the 3 the criterion asks",
  },
  {
    id: "cheaper-count",
    provider: "cheaper-inference",
    model: "gpt-5.4-nano",
    format: "anthropic-messages",
    path: "/v1/messages/count_tokens",
    query: {},
    body: { model: "gpt-5.4-nano", messages: [{ role: "user", content: PROMPT }] },
    streamed: false,
    proxyPath: "/anthropic/v1/messages/count_tokens",
    why: "final run, `cheaper-msg` count#1: the answer carried no request id header, while every other cheaper-inference answer carried `x-ci-request-id`",
  },
];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PROBE_PORT = 4144;

type Sent = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly text: string; readonly reads: { atMs: number; text: string }[] };

/** --via=proxy: a raw HTTP client of the in-process proxy, reading the body as it arrives. */
async function viaProxy(base: string, token: string, probe: Probe): Promise<Sent> {
  const body = probe.format === "anthropic-messages" ? { ...(probe.body as object), model: `${probe.provider}/${probe.model}` } : probe.body;
  const started = performance.now();
  const response = await fetch(`${base}${probe.proxyPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(probe.format === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) },
    body: JSON.stringify(body),
  });
  const reads: { atMs: number; text: string }[] = [];
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    reads.push({ atMs: performance.now() - started, text: decoder.decode(value, { stream: true }) });
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text: reads.map((r) => r.text).join(""), reads };
}

async function main(): Promise<number> {
  const probe = PROBES.find((p) => p.id === arg("probe"));
  if (probe === undefined) throw new Error(`--probe=<${PROBES.map((p) => p.id).join("|")}>`);
  const runs = Number(arg("runs") ?? (probe.streamed ? "4" : "1"));
  const live = await openLive();
  const provider: ProviderPort | undefined = live.gateways.find((g) => g.spec.provider === probe.provider)?.provider;
  if (provider === undefined) throw new Error(`${probe.provider} is not enabled`);
  const capturedAt = new Date().toISOString();
  const rows: string[] = [];
  const round = (n: number | undefined) => (n === undefined ? "–" : String(Math.round(n)));
  const via = arg("via") === "proxy";
  let server: NodeHttpServer | undefined;
  let token = "";
  if (via) {
    const routes = buildRoutes(live.graph, live.home, [process.execPath, "apps/proxy/src/main/cli.ts"]);
    server = new NodeHttpServer(routes.handler, { host: LOOPBACK_HOST, port: PROBE_PORT, maxBodyBytes: MAX_BODY_BYTES }, routes.errors);
    await server.start();
    token = await routes.ports.access.token();
    live.redactor.add("proxy_token", token);
  }
  const base = `http://${LOOPBACK_HOST}:${PROBE_PORT}`;
  for (let run = 1; run <= runs; run++) {
    const mark = live.recorder.mark();
    let sent: Sent;
    if (via) {
      sent = await viaProxy(base, token, probe);
    } else {
      const response = await provider.passthrough(probe.model, {
        format: probe.format,
        path: probe.path,
        query: probe.query,
        headers: { "content-type": "application/json", ...(probe.format === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) },
        body: JSON.stringify(probe.body),
        lossy: false,
        signal: new AbortController().signal,
      });
      sent = { status: response.status, headers: response.headers, text: await readAll(response.body), reads: [] };
    }
    const exchange = live.recorder.since(mark).at(-1)!;
    const id = `${probe.id}${via ? "-via-proxy" : ""}-${run}`;
    const file = `tests/fixtures/captures/p0-live/p6/${id}.json`;
    writeCapture(live, file, { id, target: probe.provider, scenario: probe.id, model: probe.model, capturedAt, exchanges: live.recorder.since(mark) });
    const upstreamIds = REQUEST_ID_HEADERS.filter((h) => exchange.responseHeaders?.[h] !== undefined).join(" ") || "(none)";
    const forwardedIds = REQUEST_ID_HEADERS.filter((h) => sent.headers[h] !== undefined).join(" ") || "(none)";
    let row: string;
    if (probe.streamed) {
      const chunks = exchange.chunks.map((c) => ({ atMs: c.atMs, text: c.text }));
      const a = analyseStream(probe.format, sseEvents(chunks));
      const upstream = `${round(exchange.headersAtMs)} | ${round(a.firstTokenMs)} | ${round(a.lastEventMs)} | ${chunks.length} | ${a.textReads} | ${round(a.textSpanMs)} | ${round(a.maxGapMs)} | ${a.terminal ? "yes" : "no"}`;
      const c = via ? analyseStream(probe.format, sseEvents(sent.reads)) : undefined;
      const client = c === undefined ? "" : ` ${sent.reads.length} | ${c.textReads} | ${round(c.textSpanMs)} | ${round(c.maxGapMs)} | ${c.terminal ? "yes" : "no"} |`;
      row = `| ${run} | ${sent.status} | ${upstream} | ${upstreamIds} |${client} \`${file}\` |`;
    } else {
      row = `| ${run} | ${sent.status} | ${round(exchange.headersAtMs)} | ${upstreamIds} | ${forwardedIds} | \`${live.redactor.text(sent.text.slice(0, 80))}\` | \`${file}\` |`;
    }
    rows.push(row);
    console.log(row);
    if (run < runs) await sleep(PACE_MS);
  }
  await server?.stop(1000);
  const header = probe.streamed
    ? via
      ? "| Run | HTTP | Upstream headers | Upstream first answer text | Upstream last event | Upstream chunks | Upstream chunks with answer text | Upstream text span | Upstream max gap | Upstream terminal | Upstream request id | Client reads | Client reads with answer text | Client text span | Client max gap | Client terminal | Capture |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
      : "| Run | HTTP | Headers | First answer text | Last event | Chunks | Chunks with answer text | Text span | Max gap | Terminal | Upstream request id | Capture |\n|---|---|---|---|---|---|---|---|---|---|---|---|"
    : "| Run | HTTP | Headers | Upstream request id | Forwarded request id | Body | Capture |\n|---|---|---|---|---|---|---|";
  const ts = timestamp();
  const doc = `docs/reference/${ts}-p6-upstream-probe-${probe.id}${via ? "-via-proxy" : ""}.md`;
  writeDoc(
    live,
    doc,
    `# P6 probe: ${probe.id}, the upstream's side

Generated by \`scripts/evidence/live/p6-upstream-probe.ts --probe=${probe.id}${via ? " --via=proxy" : ""}\` on ${capturedAt}
([plan](../plans/2026-10-17-22-59-p6-live-results-plan.md), [final results](2026-10-18-20-07-p6-live-results.md)).
Why: ${probe.why}. The request \`${JSON.stringify(probe.body)}\` (${probe.format}, \`${probe.path}\`) goes to
\`${probe.provider}/${probe.model}\` through the production provider's \`passthrough\`, the call the daemon's route makes;
the recording transport times the upstream's response headers and every chunk as the upstream delivered it (ms since
the request was sent) and keeps its response headers. "Forwarded" is what the provider hands the daemon's route.
${via ? `This run is \`--via=proxy\`: the request is sent by a raw HTTP client (body read as it arrives) to the daemon's own request handling served in-process on \`${base}\`; "Client" columns are that client's network reads of the same request (ms since the client sent it).\n` : ""}
${header}
${rows.join("\n")}
`,
  );
  console.log(`wrote ${doc}`);
  return 0;
}

process.exit(await main());
