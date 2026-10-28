// R5: one captured client request (plane A) against the proxy's request for the same call (plane B).
//
// Plane B is produced hermetically: a signed-in proxy daemon (the e2e harness: source entry, replay upstreams, fake
// browser logins) receives the request the client would send to it, and a wire tap between the daemon and the replay
// upstream records the proxy's outbound request byte for byte. No provider is contacted.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalise, type WireRequest } from "@accounts-proxy/scripts/recon/parity/canon.ts";
import { cellOf } from "@accounts-proxy/scripts/recon/parity/cells.ts";
import { diffRequests, type Gap } from "@accounts-proxy/scripts/recon/parity/diff.ts";
import { WireTap, type TappedRequest } from "@accounts-proxy/scripts/recon/parity/tap.ts";
import { BOTH_PROVIDERS, startSignedInDaemon, writePool } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { jsonResponse, ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

export type CaptureRecord = {
  readonly seq: number;
  readonly run: string;
  readonly client: string;
  readonly clientVersion: string;
  readonly method: string;
  readonly url: string;
  readonly httpVersion?: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
  readonly bodyEncoding?: string;
};

export type Comparison = {
  readonly capture: { readonly client: string; readonly version: string; readonly run: string; readonly seq: number; readonly url: string; readonly httpVersion?: string };
  readonly mapping: string;
  readonly proxy: {
    readonly status: number;
    readonly upstreamRequests: number;
    readonly httpVersion?: string;
    /** Every other upstream call the proxy made while it served this request (`METHOD /path`), in order. */
    readonly otherUpstream: readonly string[];
  };
  /**
   * The proxy's answer when it refused the client's request as sent (strict translation). The comparison then repeats
   * the request with `x-proxy-lossy: 1`, so the rest of the request can still be compared; the refusal is itself a gap.
   */
  readonly refusal?: { readonly status: number; readonly body: string; readonly dropped?: string };
  readonly gaps: readonly Gap[];
};

function captureFile(runDir: string, seq: number, side: "request" | "response"): string {
  const dir = join(runDir, "captures");
  const name = readdirSync(dir).find((file) => file.endsWith(`-${side}.json`) && Number(file.split("-")[0]) === seq);
  if (name === undefined) throw new Error(`no ${side} with seq ${seq} in ${dir}`);
  return join(dir, name);
}

export function readCapture(runDir: string, seq: number): CaptureRecord {
  return JSON.parse(readFileSync(captureFile(runDir, seq, "request"), "utf8")) as CaptureRecord;
}

function wire(record: CaptureRecord): WireRequest {
  if (record.bodyEncoding !== undefined && record.bodyEncoding !== "utf8" && record.bodyEncoding !== "text") {
    throw new Error(`capture ${record.seq}: body encoding ${record.bodyEncoding} is not comparable as text`);
  }
  return { method: record.method, url: record.url, headers: record.headers, body: record.body ?? "", ...(record.httpVersion === undefined ? {} : { httpVersion: record.httpVersion }) };
}

/**
 * The run's own answers for the control calls the proxy makes while it serves this request, so the proxy resolves the
 * model against the catalogue the client itself received rather than against an older fixture.
 */
function scriptFromRun(upstreams: ReplayUpstreams, runDir: string): number {
  const dir = join(runDir, "captures");
  let scripted = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith("-request.json")).sort()) {
    const request = JSON.parse(readFileSync(join(dir, file), "utf8")) as { url?: string };
    const path = new URL(request.url ?? "http://x.invalid").pathname;
    if (path !== "/v1internal:fetchAvailableModels") continue;
    const responseFile = join(dir, file.replace("-request.json", "-response.json"));
    if (!existsSync(responseFile)) continue;
    const response = JSON.parse(readFileSync(responseFile, "utf8")) as { status?: number; body?: string | null };
    if (response.status !== 200 || typeof response.body !== "string") continue;
    const body = JSON.parse(response.body) as unknown;
    // Answer every catalogue read of the session from the client's own catalogue.
    upstreams.script(path, ...Array.from({ length: 20 }, () => () => jsonResponse(body)));
    scripted += 1;
    break;
  }
  return scripted;
}

/**
 * Every listed capture is sent, in order, to one signed-in daemon: a conversation keeps the proxy's per-session state
 * (Antigravity's trajectory step counter and labels) as it was for the client, which a fresh daemon per request
 * would reset.
 */
export async function compare(runDir: string, seqs: readonly number[]): Promise<Comparison[]> {
  const records = seqs.map((seq) => readCapture(runDir, seq));
  const upstreams = new ReplayUpstreams().start();
  const tap = new WireTap(Number(new URL(upstreams.origin).port));
  const origin = `http://127.0.0.1:${await tap.start()}`;
  const seams = Object.fromEntries(Object.keys(upstreams.seamEnv()).map((name) => [name, origin]));
  scriptFromRun(upstreams, runDir);
  const setups = [...new Set(records.map((record) => cellOf(record.client, record.url)))].flatMap((cell) => (cell.daemon === undefined ? [] : [cell.daemon]));
  const yaml = `${BOTH_PROVIDERS}${setups.map((setup) => setup.providers).join("")}`;
  const env = await startSignedInDaemon(seams, yaml, (home) => {
    for (const setup of setups) {
      for (const [provider, pool] of Object.entries(setup.pools)) writePool(home, provider, pool);
    }
  });
  try {
    const results: Comparison[] = [];
    for (const record of records) {
      const cell = cellOf(record.client, record.url);
      const input = cell.input(wire(record), env.token);
      const send = async (extra: readonly (readonly [string, string])[]) => {
        const mark = tap.requests.length;
        const response = await fetch(`${env.daemon.url}${input.target}`, { method: "POST", headers: [...input.headers, ...extra].map(([n, v]) => [n, v]), body: input.body });
        const answer = await response.text();
        const counterpart = cell.isCounterpart ?? ((path: string) => path === cell.upstreamPath);
        const path = (request: TappedRequest) => new URL(request.url, "http://x.invalid").pathname;
        const window = tap.requests.slice(mark);
        const outbound: TappedRequest[] = window.filter((request) => counterpart(path(request)));
        const other = window.filter((request) => !counterpart(path(request))).map((request) => `${request.method} ${path(request)}`);
        return { response, answer, outbound, other };
      };
      let attempt = await send([]);
      let refusal: Comparison["refusal"];
      if (attempt.outbound.length === 0) {
        refusal = { status: attempt.response.status, body: attempt.answer };
        attempt = await send([["x-proxy-lossy", "1"]]);
        const dropped = attempt.response.headers.get("x-proxy-dropped");
        if (dropped !== null) refusal = { ...refusal, dropped };
      }
      const { response, answer, outbound, other } = attempt;
      const counterpart = outbound.at(-1);
      if (counterpart === undefined) throw new Error(`seq ${record.seq}: the proxy sent no ${cell.upstreamPath} request (answer ${response.status}: ${answer.slice(0, 400)})`);
      results.push({
        capture: { client: record.client, version: record.clientVersion, run: record.run, seq: record.seq, url: record.url, ...(record.httpVersion === undefined ? {} : { httpVersion: record.httpVersion }) },
        mapping: cell.mapping,
        proxy: { status: response.status, upstreamRequests: outbound.length, ...(counterpart.httpVersion === undefined ? {} : { httpVersion: counterpart.httpVersion }), otherUpstream: other },
        gaps: diffRequests(canonicalise(wire(record)), canonicalise(counterpart), cell.ignoreHeaders),
        ...(refusal === undefined ? {} : { refusal }),
      });
    }
    return results;
  } finally {
    await env.daemon.stop();
    tap.stop();
    upstreams.stop();
    removeTemporary(env.home.dir);
  }
}

/** A value short enough to read, else its length, a hash and its start. */
export function render(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown =
    text.length <= 120
      ? text
      : `${text.length} chars, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)}: ${text.slice(0, 80)}…`;
  return `\`${shown.replace(/`/g, "'").replace(/\|/g, "\\|").replace(/\n/g, "\\n")}\``;
}

export function markdown(comparison: Comparison): string {
  const { capture, proxy, gaps } = comparison;
  const lines = [
    `### ${capture.client} ${capture.version} — capture \`${capture.run}\` seq ${capture.seq}`,
    "",
    `Client request: \`${capture.url.replace(/\?.*$/, "")}\` (${capture.httpVersion ?? "unknown HTTP version"}). Proxy answer to the client: ${proxy.status}; proxy upstream requests on that path: ${proxy.upstreamRequests} (${proxy.httpVersion ?? "?"} to the loopback tap). Other proxy upstream calls during this request: ${proxy.otherUpstream.length === 0 ? "none" : proxy.otherUpstream.map((call) => `\`${call}\``).join(", ")}.`,
    "",
    comparison.mapping,
    "",
    ...(comparison.refusal === undefined
      ? []
      : [
          `**Refused as sent:** ${comparison.refusal.status} ${render(comparison.refusal.body)}. The rows below compare the request repeated with \`x-proxy-lossy: 1\`${comparison.refusal.dropped === undefined ? "" : `, which dropped ${render(comparison.refusal.dropped)}`}.`,
          "",
        ]),
    `${gaps.length} difference(s).`,
    "",
    "| # | Kind | Where | Client (plane A) | Proxy (plane B) |",
    "|---|---|---|---|---|",
    ...gaps.map((gap, index) => `| ${index + 1} | ${gap.kind} | ${render(gap.where)} | ${render(gap.client)} | ${render(gap.proxy)} |`),
    "",
  ];
  return lines.join("\n");
}

export const runName = (runDir: string) => basename(runDir.replace(/\/+$/, ""));
