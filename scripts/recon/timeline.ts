/**
 * Workflow timeline (plan 2026-10-19-20-04 §17).
 *
 * The addon records one flat sequence of exchanges per run. A workflow is the same exchanges read through the step
 * markers the driver writes while it acts: `steps.jsonl` carries `{atMs, name, phase}` on the host clock, and every
 * capture record carries `wallAtMs` on the same clock. `buildTimeline` joins them, so a run becomes
 * `step → flows → connections` without any guess about which exchange belongs to which turn.
 *
 * The builder is pure: it takes records, connections and markers and returns the timeline. Reading a run directory
 * and writing `timeline.json` are thin wrappers around it, which keeps the join rule unit-testable.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One record as the addon writes it. Only the fields the timeline needs are typed; the record keeps the rest. */
export interface CaptureRecord {
  readonly schema: string;
  readonly seq: number;
  readonly wallAtMs?: number;
  readonly atMs?: number;
  readonly method?: string;
  readonly url?: string;
  readonly status?: number;
  readonly body?: string | null;
  readonly bodyEncoding?: string;
  readonly chunks?: readonly { readonly atMs: number; readonly bytes: number; readonly text: string | null }[];
  readonly streamed?: boolean;
  readonly aborted?: boolean;
  readonly clientClosed?: boolean;
  readonly error?: string | null;
  readonly errorClass?: string;
  readonly frames?: readonly {
    readonly fromClient: boolean;
    readonly bytes: number;
    readonly text?: string | null;
    readonly body?: string;
  }[];
  readonly noise?: boolean;
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly clientConn?: { readonly id?: string | null };
  readonly serverConn?: { readonly id?: string | null };
  readonly doneAtMs?: number;
  readonly headersAtMs?: number;
}

/** One marker the driver appended to `steps.jsonl`. */export interface StepMarker {
  readonly atMs: number;
  readonly name: string;
  readonly phase: "start" | "end" | "point";
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A connection the run opened, with the ClientHello the client offered on it. */
export interface TimelineConnection {
  readonly id: string | null;
  readonly sni: string | null;
  readonly alpn: string | null;
  readonly alpnOffers: readonly string[];
  readonly ja3: string | null;
  readonly ja3Hash: string | null;
  readonly tlsVersion: string | null;
}

/** One exchange in a step. Requests and responses stay separate records joined by `seq`. */
export interface TimelineFlow {
  readonly seq: number;
  readonly kind: "request" | "response" | "websocket" | "error";
  readonly wallAtMs: number | null;
  readonly atMs: number | null;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly status?: number | undefined;
  readonly bytes?: number | undefined;
  readonly chunks?: number | undefined;
  readonly streamed?: boolean | undefined;
  readonly aborted?: boolean | undefined;
  readonly clientClosed?: boolean | undefined;
  readonly frames?: number | undefined;
  readonly sseFrames?: number | undefined;
  readonly error?: string | null | undefined;
  readonly errorClass?: string | undefined;
  readonly noise: boolean;
  readonly truncated: boolean;
  readonly clientConnId: string | null;
  readonly serverConnId: string | null;
}

/** One driver step, with the exchanges that happened while it was open. */
export interface TimelineStep {
  readonly name: string;
  readonly startAtMs: number;
  endAtMs: number | null;
  readonly marks: readonly StepMarker[];
  readonly flows: TimelineFlow[];
}

/** The whole run as a workflow. */
export interface Timeline {
  readonly schema: "recon-timeline/1";
  readonly run: string;
  readonly client: string;
  readonly clientVersion: string;
  readonly cell: string;
  readonly generatedAtMs: number;
  readonly durationMs: number;
  readonly steps: readonly TimelineStep[];
  readonly unmarked: readonly TimelineFlow[];
  readonly connections: readonly TimelineConnection[];
  readonly summary: Readonly<Record<string, number>>;
}

/** Everything `buildTimeline` needs, independent of where it was read from. */
export interface TimelineInput {
  readonly run: string;
  readonly client: string;
  readonly clientVersion: string;
  readonly cell: string;
  readonly records: readonly CaptureRecord[];
  readonly connections: readonly Record<string, unknown>[];
  readonly markers: readonly StepMarker[];
  readonly nowMs?: number;
}

/** Byte length of a record body, whether it is UTF-8 text or base64. */
function bodyBytes(record: CaptureRecord): number {
  if (typeof record.body !== "string") return 0;
  if (record.bodyEncoding === "base64") return Buffer.from(record.body, "base64").length;
  return Buffer.byteLength(record.body, "utf8");
}

/** One record as a timeline flow. */
function toFlow(record: CaptureRecord): TimelineFlow {
  const common = {
    seq: record.seq,
    wallAtMs: record.wallAtMs ?? null,
    atMs: record.atMs ?? null,
    noise: record.noise === true,
    truncated: record.truncated === true,
    clientConnId: record.clientConn?.id ?? null,
    serverConnId: record.serverConn?.id ?? null,
  } as const;
  if (record.schema.startsWith("recon-request/")) {
    return { ...common, kind: "request", method: record.method, url: record.url, bytes: bodyBytes(record) };
  }
  if (record.schema.startsWith("recon-response/")) {
    const chunkBytes = (record.chunks ?? []).reduce((total, chunk) => total + chunk.bytes, 0);
    return {
      ...common,
      kind: "response",
      status: record.status,
      url: record.url,
      bytes: record.body !== undefined ? bodyBytes(record) : chunkBytes,
      chunks: record.chunks?.length,
      sseFrames: record.frames?.length,
      streamed: record.streamed === true,
      aborted: record.aborted === true,
      clientClosed: record.clientClosed === true,
      error: record.error ?? null,
    };
  }
  if (record.schema.startsWith("recon-websocket/")) {
    return {
      ...common,
      kind: "websocket",
      url: record.url,
      bytes: (record.frames ?? []).reduce((total, frame) => total + frame.bytes, 0),
      frames: record.frames?.length,
    };
  }
  return {
    ...common,
    kind: "error",
    url: record.url,
    error: record.error ?? null,
    errorClass: record.errorClass,
  };
}

/** Sort records into one chronological list, tolerating records from before `wallAtMs` existed. */
function chronological(records: readonly CaptureRecord[]): TimelineFlow[] {
  return records
    .map(toFlow)
    .sort((a, b) => {
      if (a.wallAtMs !== null && b.wallAtMs !== null && a.wallAtMs !== b.wallAtMs) return a.wallAtMs - b.wallAtMs;
      return a.seq - b.seq;
    });
}

/**
 * Build the timeline. A flow belongs to the step whose start marker is the latest one at or before the flow and whose
 * end marker (if any) is at or after it. A flow outside every step is kept in `unmarked`, never dropped.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const steps: TimelineStep[] = [];
  const open: { step: TimelineStep; mutable: { marks: StepMarker[] } }[] = [];
  // A step's end marker takes the same millisecond as the next step's start marker, so the sort must be stable and
  // must not use the name as a tiebreak: `--continue` sorts before `--title`, which once swapped two steps' ends.
  const markers = [...input.markers].sort((a, b) => a.atMs - b.atMs);
  for (const marker of markers) {
    if (marker.phase === "start") {
      const mutable = { marks: [] as StepMarker[] };
      const step: TimelineStep = { name: marker.name, startAtMs: marker.atMs, endAtMs: null, marks: mutable.marks, flows: [] };
      steps.push(step);
      open.push({ step, mutable });
    } else if (marker.phase === "end") {
      // Close the most recent step of that name, so two steps that share a name still close in order.
      for (let index = open.length - 1; index >= 0; index -= 1) {
        const candidate = open[index]!;
        if (candidate.step.name !== marker.name) continue;
        (candidate.step as { endAtMs: number | null }).endAtMs = marker.atMs;
        open.splice(index, 1);
        break;
      }
    } else {
      const current = open[open.length - 1];
      if (current !== undefined) current.mutable.marks.push(marker);
    }
  }

  const unmarked: TimelineFlow[] = [];
  const flows = chronological(input.records);
  for (const flow of flows) {
    const at = flow.wallAtMs;
    const owner =
      at === null
        ? undefined
        : steps.find((step) => step.startAtMs <= at && (step.endAtMs === null || at <= step.endAtMs));
    if (owner === undefined) {
      unmarked.push(flow);
    } else {
      (owner.flows as TimelineFlow[]).push(flow);
    }
  }

  const connections = input.connections.map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : null,
    sni: typeof entry.sni === "string" ? entry.sni : null,
    alpn: typeof entry.alpn === "string" ? entry.alpn : null,
    alpnOffers: Array.isArray(entry.alpnOffers) ? (entry.alpnOffers as string[]) : [],
    ja3: typeof entry.ja3 === "string" ? entry.ja3 : null,
    ja3Hash: typeof entry.ja3Hash === "string" ? entry.ja3Hash : null,
    tlsVersion: typeof entry.tlsVersion === "string" ? entry.tlsVersion : null,
  }));

  const all = [...flows];
  const summary: Record<string, number> = {
    steps: steps.length,
    requests: all.filter((flow) => flow.kind === "request").length,
    responses: all.filter((flow) => flow.kind === "response").length,
    streamed: all.filter((flow) => flow.streamed === true).length,
    sseFrames: all.reduce((total, flow) => total + (flow.sseFrames ?? 0), 0),
    aborted: all.filter((flow) => flow.aborted === true).length,
    clientClosed: all.filter((flow) => flow.clientClosed === true).length,
    websockets: all.filter((flow) => flow.kind === "websocket").length,
    websocketFrames: all.reduce((total, flow) => total + (flow.frames ?? 0), 0),
    errors: all.filter((flow) => flow.kind === "error").length,
    noise: all.filter((flow) => flow.noise).length,
    truncated: all.filter((flow) => flow.truncated).length,
    unmarked: all.filter((flow) => unmarked.includes(flow)).length,
    connections: connections.length,
    requestBytes: all.filter((flow) => flow.kind === "request").reduce((total, flow) => total + (flow.bytes ?? 0), 0),
    responseBytes: all.filter((flow) => flow.kind === "response").reduce((total, flow) => total + (flow.bytes ?? 0), 0),
    websocketBytes: all.filter((flow) => flow.kind === "websocket").reduce((total, flow) => total + (flow.bytes ?? 0), 0),
  };
  const start = steps.length > 0 ? Math.min(...steps.map((step) => step.startAtMs)) : null;
  const end = Math.max(
    input.nowMs ?? Date.now(),
    ...steps.map((step) => step.endAtMs ?? step.startAtMs),
    ...flows.map((flow) => flow.wallAtMs ?? 0),
  );
  summary.durationMs = start === null ? 0 : Math.max(0, end - start);

  return {
    schema: "recon-timeline/1",
    run: input.run,
    client: input.client,
    clientVersion: input.clientVersion,
    cell: input.cell,
    generatedAtMs: input.nowMs ?? Date.now(),
    durationMs: summary.durationMs ?? 0,
    steps,
    unmarked,
    connections,
    summary,
  };
}

/** Read one run directory: every capture record, the connection registry, and the driver's markers. */
export function readRun(runDir: string): {
  records: CaptureRecord[];
  connections: Record<string, unknown>[];
  markers: StepMarker[];
} {
  const captures = join(runDir, "captures");
  const records: CaptureRecord[] = [];
  if (existsSync(captures)) {
    for (const name of readdirSync(captures).sort()) {
      if (!name.endsWith(".json") || name === "index.json" || name === "connections.json") continue;
      records.push(JSON.parse(readFileSync(join(captures, name), "utf8")) as CaptureRecord);
    }
  }
  const registry = join(captures, "connections.json");
  const connections = existsSync(registry)
    ? ((JSON.parse(readFileSync(registry, "utf8")) as { connections?: Record<string, unknown>[] }).connections ?? [])
    : [];
  const steps = join(runDir, "steps.jsonl");
  const markers = existsSync(steps)
    ? readFileSync(steps, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StepMarker)
    : [];
  return { records, connections, markers };
}

/** Read a run and write `timeline.json` beside it. Returns the timeline that was written. */
export function writeTimeline(runDir: string): Timeline {
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as {
    run?: string;
    client?: string;
    version?: string;
    cell?: string;
  };
  const { records, connections, markers } = readRun(runDir);
  const timeline = buildTimeline({
    run: run.run ?? runDir,
    client: run.client ?? "unknown",
    clientVersion: run.version ?? "unknown",
    cell: run.cell ?? "unknown",
    records,
    connections,
    markers,
  });
  const path = join(runDir, "timeline.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(timeline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return timeline;
}
