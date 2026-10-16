// Shared P0-LIVE harness (plan 2026-10-07-01-23 §6): refuses to run without ACCOUNTS_PROXY_LIVE=1, wires the
// providers through the proxy composition root over a RecordingTransport, collects every secret into a Redactor,
// paces upstream calls 2 s apart, stops the whole run at the first quota signal, and writes redacted capture files.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QuotaExhaustedError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { PROVIDER_IDS } from "@accounts-proxy/core/domain/models.ts";
import { SseCodec } from "@accounts-proxy/core/domain/services/event-stream.ts";
import { readAll, UPSTREAM_IDLE_TIMEOUT_MS } from "@accounts-proxy/core/domain/wire.ts";
import { activeProject } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import type { ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { TrajectoryState, type TrajectorySnapshot } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";
import type { ChatMessage } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { FetchTransport, type FetchFunction } from "@accounts-proxy/proxy/adapters/outbound/fetch-transport.ts";
import { buildGraph, defaultHome, PRODUCTION_LOCK, type AntigravityGraph, type ClaudeGraph, type GatewayGraph, type OpenAIGraph, type ProviderGraph } from "@accounts-proxy/proxy/composition/container.ts";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import { Redactor } from "@accounts-proxy/scripts/evidence/live/redact.ts";
import { RecordingTransport, type Exchange } from "@accounts-proxy/scripts/evidence/live/recording-transport.ts";

export const PACE_MS = 2000;

export class StopRun extends Error {}

export type Live = {
  readonly graph: ProviderGraph;
  readonly claude: ClaudeGraph;
  readonly antigravity: AntigravityGraph;
  /** Present when the openai provider is enabled (plan v4 P4.5). */
  readonly openai: OpenAIGraph | undefined;
  /** The enabled API-key gateways (plan P4.6). */
  readonly gateways: readonly GatewayGraph[];
  readonly recorder: RecordingTransport;
  readonly redactor: Redactor;
  readonly trajectory: TrajectoryState;
  readonly home: string;
};

export function requireLive(): void {
  if (process.env["ACCOUNTS_PROXY_LIVE"] !== "1") {
    console.error("refusing to run: set ACCOUNTS_PROXY_LIVE=1 (this script calls the real provider accounts)");
    process.exit(2);
  }
}

export async function openLive(): Promise<Live> {
  requireLive();
  const home = defaultHome(process.env);
  const recorder = new RecordingTransport(new FetchTransport(fetch as unknown as FetchFunction, UPSTREAM_IDLE_TIMEOUT_MS));
  const graph = await buildGraph({ home, transport: recorder, lock: PRODUCTION_LOCK, seams: {} });
  if (graph.claude === undefined || graph.antigravity === undefined) throw new Error("both providers must be enabled in proxy.yaml");
  const redactor = new Redactor();
  for (const provider of PROVIDER_IDS) {
    const pool = await graph.store.load(provider);
    for (const account of pool.accounts) {
      redactor.add("account_id", account.id);
      redactor.add("account_label", account.label);
      collectStrings(account.data, "", redactor);
    }
  }
  redactor.add("claude_device_id", await graph.claude.identity.deviceId());
  redactor.add("claude_session_id", graph.claude.identity.sessionId);
  if (graph.openai !== undefined) {
    redactor.add("openai_host_id", await graph.openai.identity.hostId());
    redactor.add("openai_session_id", graph.openai.identity.sessionId);
  }
  const sessionId = await graph.antigravity.state.sessionId();
  redactor.add("antigravity_session_id", sessionId);
  const trajectory = new TrajectoryState({ sessionUuid: graph.random.uuid(), sessionId, uuid: () => graph.random.uuid(), now: () => graph.clock.now() });
  return { graph, claude: graph.claude, antigravity: graph.antigravity, openai: graph.openai, gateways: graph.gateways, recorder, redactor, trajectory, home };
}

/** Every string leaf of an account record that names or authenticates the user is a secret. */
function collectStrings(value: unknown, key: string, redactor: Redactor): void {
  if (typeof value === "string") {
    if (/token|email|uuid|project|label|subject|key$|id$/i.test(key) && !/scope/i.test(key)) redactor.add(key.replace(/[^a-z0-9]+/gi, "_").toLowerCase(), value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, redactor);
    return;
  }
  if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) collectStrings(v, k, redactor);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quota signals stop the run (no rotation, no retry: plan D4). */
export function quotaSignal(status: number | undefined, text: string): boolean {
  return status === 429 || text.includes("RESOURCE_EXHAUSTED");
}

// ---------------------------------------------------------------- Claude (native Anthropic Messages passthrough)

export type ClaudeResult = { readonly status: number; readonly text: string; readonly events: Array<Record<string, unknown>> };

export async function claudeMessages(live: Live, model: string, body: Record<string, unknown>): Promise<ClaudeResult> {
  const response = await live.claude.provider.passthrough(model, { format: "anthropic-messages", path: "/v1/messages", query: {}, headers: {}, body: JSON.stringify(body), lossy: false });
  const text = await readAll(response.body);
  const events: Array<Record<string, unknown>> = [];
  if ((response.headers["content-type"] ?? "").includes("text/event-stream")) {
    const codec = new SseCodec();
    for (const frame of codec.push(text)) {
      try {
        events.push(JSON.parse(frame.data) as Record<string, unknown>);
      } catch {
        /* non-JSON frame kept in the raw capture */
      }
    }
  }
  if (quotaSignal(response.status, text)) throw new StopRun(`claude quota signal: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { status: response.status, text, events };
}

/** Rebuilds the assistant content blocks of a streamed Anthropic message (text, thinking, tool_use). */
export function anthropicContent(events: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const partialJson: string[] = [];
  for (const e of events) {
    const index = e["index"] as number;
    if (e["type"] === "content_block_start") {
      blocks[index] = { ...(e["content_block"] as Record<string, unknown>) };
      partialJson[index] = "";
    } else if (e["type"] === "content_block_delta") {
      const delta = e["delta"] as Record<string, unknown>;
      const block = blocks[index]!;
      if (delta["type"] === "text_delta") block["text"] = String(block["text"] ?? "") + String(delta["text"]);
      if (delta["type"] === "thinking_delta") block["thinking"] = String(block["thinking"] ?? "") + String(delta["thinking"]);
      if (delta["type"] === "signature_delta") block["signature"] = String(delta["signature"]);
      if (delta["type"] === "input_json_delta") partialJson[index] += String(delta["partial_json"]);
    }
  }
  return blocks.map((b, i) => (b["type"] === "tool_use" ? { ...b, input: partialJson[i] ? JSON.parse(partialJson[i]!) : {} } : b));
}

export function stopReason(events: ReadonlyArray<Record<string, unknown>>): string | undefined {
  for (const e of events) if (e["type"] === "message_delta") return (e["delta"] as Record<string, unknown>)["stop_reason"] as string;
  return undefined;
}

// ---------------------------------------------------------------- Antigravity (cloudcode-pa envelope)

export type AntigravityResult = {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
  readonly envelopes: StreamEnvelope[];
};

/**
 * One generation through the production API client: proactive session refresh, the trajectory snapshot (labels,
 * requestId, int64 sessionId string), the outer envelope and the captured user agent. `build` receives the snapshot
 * and returns the inner Gemini request body.
 */
export async function antigravityGenerate(
  live: Live,
  model: ModelDescriptor,
  messages: readonly ChatMessage[],
  build: (snapshot: TrajectorySnapshot) => Record<string, unknown>,
): Promise<AntigravityResult> {
  const active = await live.antigravity.session.active();
  const project = activeProject(active.account);
  if (project === undefined) throw new Error("antigravity account has no project");
  const snapshot = live.trajectory.begin(model.wireId, model.enumPlaceholder, messages);
  const envelopes: StreamEnvelope[] = [];
  try {
    for await (const envelope of live.antigravity.api.streamGenerate(
      { project, requestId: snapshot.requestId, body: build(snapshot), modelWireId: model.wireId },
      active.account.tokens,
      undefined,
    )) {
      envelopes.push(envelope);
    }
    live.trajectory.complete();
    return { ok: true, envelopes };
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw new StopRun(`antigravity quota signal: ${error.message}`);
    if (error instanceof UpstreamError) {
      if (quotaSignal(error.httpStatus, error.body)) throw new StopRun(`antigravity quota signal: HTTP ${error.httpStatus} ${error.body.slice(0, 300)}`);
      return { ok: false, status: error.httpStatus, error: error.body, envelopes };
    }
    throw error;
  }
}

export async function antigravityModel(live: Live, wireId: string): Promise<ModelDescriptor> {
  const descriptor = await live.antigravity.catalog.descriptor(wireId);
  if (descriptor === undefined) throw new Error(`antigravity catalog has no ${wireId}`);
  return descriptor;
}

// ---------------------------------------------------------------- capture files

export type CaptureRecord = {
  readonly id: string;
  readonly target: string;
  readonly scenario: string;
  readonly model: string;
  readonly capturedAt: string;
  readonly exchanges: Exchange[];
  readonly note?: string;
};

export function redactExchange(redactor: Redactor, exchange: Exchange): Record<string, unknown> {
  const bodyText = exchange.request.body ?? "";
  let body: unknown = bodyText;
  try {
    body = JSON.parse(redactor.body(bodyText));
  } catch {
    body = redactor.text(bodyText);
  }
  return {
    request: { method: exchange.request.method, url: redactor.text(exchange.request.url), headers: redactor.headers(exchange.request.headers), body },
    response: {
      status: exchange.status,
      headers: exchange.responseHeaders === undefined ? undefined : redactor.headers(exchange.responseHeaders),
      headersAtMs: round(exchange.headersAtMs),
      doneAtMs: round(exchange.doneAtMs),
      chunks: exchange.chunks.map((c) => ({ atMs: round(c.atMs), text: redactor.text(c.text) })),
    },
    ...(exchange.error !== undefined ? { error: redactor.text(exchange.error) } : {}),
  };
}

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);

/** Token-endpoint exchanges are never persisted, only counted (they carry grants). */
export function isTokenEndpoint(url: string): boolean {
  return url.startsWith("https://oauth2.googleapis.com/token") || url.includes("/v1/oauth/token") || url.includes("/api/accounts/oauth/token") || url.includes("/auth/device/token");
}

export function writeCapture(live: Live, relativePath: string, record: CaptureRecord): string {
  const persisted = record.exchanges.filter((e) => !isTokenEndpoint(e.request.url));
  const output = `${JSON.stringify(
    {
      id: record.id,
      target: record.target,
      scenario: record.scenario,
      model: record.model,
      capturedAt: record.capturedAt,
      ...(record.note !== undefined ? { note: record.note } : {}),
      tokenEndpointExchangesOmitted: record.exchanges.length - persisted.length,
      exchanges: persisted.map((e) => redactExchange(live.redactor, e)),
    },
    null,
    2,
  )}\n`;
  const hits = live.redactor.scan(output);
  if (hits.length > 0) throw new Error(`secret scan failed for ${relativePath}: ${hits.join(", ")} (nothing written)`);
  const path = join(repositoryRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
  return path;
}

export function writeDoc(live: Live, relativePath: string, text: string): void {
  const hits = live.redactor.scan(text);
  if (hits.length > 0) throw new Error(`secret scan failed for ${relativePath}: ${hits.join(", ")} (nothing written)`);
  const path = join(repositoryRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}`;
}
