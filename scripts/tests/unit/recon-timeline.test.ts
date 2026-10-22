// Workflow timeline (plan 2026-10-19-20-04 §17): the join between the flat capture records and the driver's step
// markers. The builder is pure, so every ordering and attribution rule is asserted directly; the file round trip is
// asserted on a temporary run directory shaped like the one `runClient` writes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTimeline,
  readRun,
  writeTimeline,
  type CaptureRecord,
  type StepMarker,
} from "@accounts-proxy/scripts/recon/timeline.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) removeTemporary(root);
  root = undefined;
});

function temporary(): string {
  root = makeTemporary("recon-timeline");
  return root;
}

function request(seq: number, wallAtMs: number, body = "{}"): CaptureRecord {
  return { schema: "recon-request/2", seq, wallAtMs, atMs: wallAtMs - 1_000, method: "POST", url: "https://api.example/v1", body };
}

function response(seq: number, wallAtMs: number, chunks = 0, aborted = false): CaptureRecord {
  const record: CaptureRecord = {
    schema: "recon-response/2",
    seq,
    wallAtMs,
    atMs: wallAtMs - 1_000,
    status: 200,
    streamed: true,
    aborted,
    bodyEncoding: "utf8",
    chunks: Array.from({ length: chunks }, () => ({ atMs: 1, bytes: 10, text: "x" })),
  };
  return record;
}

const markers: StepMarker[] = [
  { atMs: 1_000, name: "run-start", phase: "point" },
  { atMs: 1_100, name: "turn", phase: "start" },
  { atMs: 1_300, name: "turn", phase: "end" },
  { atMs: 1_400, name: "second", phase: "start" },
  { atMs: 1_600, name: "second", phase: "end" },
  { atMs: 1_700, name: "run-end", phase: "point" },
];

describe("timeline join", () => {
  test("assigns each flow to the step open at its wall clock", () => {
    const timeline = buildTimeline({
      run: "selfcheck/run",
      client: "selfcheck",
      clientVersion: "1.0.0",
      cell: "claude",
      markers,
      connections: [],
      nowMs: 2_000,
      records: [request(1, 1_150), response(1, 1_250, 3), request(2, 1_450), response(2, 1_550, 0, true), request(3, 900)],
    });
    expect(timeline.steps.map((step) => step.name)).toEqual(["turn", "second"]);
    expect(timeline.steps[0]!.flows.map((flow) => flow.seq)).toEqual([1, 1]);
    expect(timeline.steps[1]!.flows.map((flow) => flow.seq)).toEqual([2, 2]);
    // Before the first step: not dropped, not misattributed.
    expect(timeline.unmarked.map((flow) => flow.seq)).toEqual([3]);
    expect(timeline.summary.requests).toBe(3);
    expect(timeline.summary.responses).toBe(2);
    expect(timeline.summary.streamed).toBe(2);
    expect(timeline.summary.aborted).toBe(1);
    expect(timeline.summary.unmarked).toBe(1);
    expect(timeline.summary.responseBytes).toBe(30);
    // From the first step (1_100) to the latest activity (nowMs 2_000).
    expect(timeline.durationMs).toBe(900);
  });

  test("closes steps that share a millisecond in file order, not name order", () => {
    // A step's end and the next step's start carry the same timestamp. Sorting by name once put `--continue` before
    // `--title`, which closed the wrong step and swallowed the second step's flows.
    const timeline = buildTimeline({
      run: "selfcheck/run",
      client: "selfcheck",
      clientVersion: "1.0.0",
      cell: "opencode",
      connections: [],
      records: [request(1, 150), request(2, 250)],
      markers: [
        { atMs: 100, name: "b", phase: "start" },
        { atMs: 200, name: "b", phase: "end" },
        { atMs: 200, name: "a", phase: "start" },
        { atMs: 300, name: "a", phase: "end" },
      ],
    });
    expect(timeline.steps.map((step) => [step.name, step.startAtMs, step.endAtMs])).toEqual([
      ["b", 100, 200],
      ["a", 200, 300],
    ]);
    expect(timeline.steps[0]!.flows.map((flow) => flow.seq)).toEqual([1]);
    expect(timeline.steps[1]!.flows.map((flow) => flow.seq)).toEqual([2]);
  });

  test("orders ties by sequence and keeps records without a wall clock unmarked", () => {
    const timeline = buildTimeline({
      run: "selfcheck/run",
      client: "selfcheck",
      clientVersion: "1.0.0",
      cell: "claude",
      markers: [{ atMs: 1_000, name: "only", phase: "start" }],
      connections: [],
      records: [
        { schema: "recon-request/2", seq: 2, wallAtMs: 1_050, method: "GET", url: "https://b" },
        { schema: "recon-request/2", seq: 1, wallAtMs: 1_050, method: "GET", url: "https://a" },
        { schema: "recon-request/2", seq: 3, method: "GET", url: "https://c" },
      ],
    });
    expect(timeline.steps[0]!.flows.map((flow) => flow.seq)).toEqual([1, 2]);
    expect(timeline.unmarked.map((flow) => flow.seq)).toEqual([3]);
    // An unterminated step stays open to the end of the run.
    expect(timeline.steps[0]!.endAtMs).toBeNull();
  });

  test("carries connection identity, JA3 and websocket frames", () => {
    const timeline = buildTimeline({
      run: "selfcheck/run",
      client: "selfcheck",
      clientVersion: "1.0.0",
      cell: "openai",
      markers: [{ atMs: 0, name: "ws", phase: "start" }],
      nowMs: 500,
      connections: [
        {
          id: "c-1",
          sni: "api.openai.com",
          alpn: "h2",
          alpnOffers: ["h2"],
          ja3: "771,4865,0-16,29,0",
          ja3Hash: "abc",
          tlsVersion: "TLSv1.3",
        },
      ],
      records: [
        {
          schema: "recon-websocket/2",
          seq: 7,
          wallAtMs: 100,
          url: "wss://api.openai.com/v1/responses",
          clientConn: { id: "c-1" },
          frames: [
            { fromClient: true, bytes: 4 },
            { fromClient: false, bytes: 6 },
          ],
        },
      ],
    });
    expect(timeline.connections).toEqual([
      {
        id: "c-1",
        sni: "api.openai.com",
        alpn: "h2",
        alpnOffers: ["h2"],
        ja3: "771,4865,0-16,29,0",
        ja3Hash: "abc",
        tlsVersion: "TLSv1.3",
      },
    ]);
    expect(timeline.steps[0]!.flows[0]).toMatchObject({ kind: "websocket", frames: 2, bytes: 10, clientConnId: "c-1" });
    expect(timeline.summary.websocketFrames).toBe(2);
    expect(timeline.summary.connections).toBe(1);
  });

  test("distinguishes a completed stream the client closed from a cancelled one", () => {
    const timeline = buildTimeline({
      run: "selfcheck/run",
      client: "selfcheck",
      clientVersion: "2.0.32",
      cell: "opencode",
      markers: [{ atMs: 100, name: "turn", phase: "start" }],
      nowMs: 400,
      connections: [],
      records: [
        {
          schema: "recon-response/3",
          seq: 1,
          wallAtMs: 200,
          url: "https://opencode.ai/inference/openai/v1/chat/completions",
          status: 200,
          streamed: true,
          aborted: false,
          clientClosed: true,
          chunks: [{ atMs: 1, bytes: 10, text: "[DONE]" }],
        },
        {
          schema: "recon-response/3",
          seq: 2,
          wallAtMs: 300,
          url: "https://opencode.ai/inference/openai/v1/chat/completions",
          status: 200,
          streamed: true,
          aborted: true,
          clientClosed: false,
          chunks: [{ atMs: 1, bytes: 10, text: "partial" }],
        },
      ],
    });
    expect(timeline.steps[0]!.flows.map((flow) => [flow.kind, flow.clientClosed, flow.aborted])).toEqual([
      ["response", true, false],
      ["response", false, true],
    ]);
    expect(timeline.summary.clientClosed).toBe(1);
    expect(timeline.summary.aborted).toBe(1);
    // The response carries the URL of the request it answers, so a gap report can name the endpoint without joining.
    expect(timeline.steps[0]!.flows[0]!.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
  });
});

describe("run directory round trip", () => {
  test("reads captures and markers, writes timeline.json, and reports the same timeline", () => {
    const runDir = temporary();
    const captures = join(runDir, "captures");
    mkdirSync(captures, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ client: "opencode", version: "2.0.32", cell: "opencode" }));
    writeFileSync(
      join(runDir, "steps.jsonl"),
      markers.map((marker) => JSON.stringify(marker)).join("\n") + "\n",
    );
    writeFileSync(join(captures, "001-request.json"), JSON.stringify(request(1, 1_150)));
    writeFileSync(join(captures, "001-response.json"), JSON.stringify(response(1, 1_250, 2)));
    writeFileSync(
      join(captures, "connections.json"),
      JSON.stringify({ schema: "recon-connections/1", connections: [{ id: "c-1", ja3Hash: "abc" }] }),
    );
    writeFileSync(join(captures, "index.json"), JSON.stringify({ schema: "recon-index/2" }));

    const read = readRun(runDir);
    expect(read.records).toHaveLength(2);
    expect(read.connections).toHaveLength(1);
    expect(read.markers).toHaveLength(markers.length);

    const written = writeTimeline(runDir);
    const parsed = JSON.parse(readFileSync(join(runDir, "timeline.json"), "utf8")) as typeof written;
    expect(parsed.schema).toBe("recon-timeline/1");
    expect(parsed.client).toBe("opencode");
    expect(parsed.clientVersion).toBe("2.0.32");
    expect(parsed.cell).toBe("opencode");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]!.flows).toHaveLength(2);
    expect(parsed.summary.requests).toBe(1);
  });
});
