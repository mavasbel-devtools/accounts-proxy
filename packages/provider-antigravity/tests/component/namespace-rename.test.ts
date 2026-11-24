// UC1/UC2 component tests for the Antigravity namespace alias (tools.opencode. <-> tools.agy.).
// UC1 drives the cell's build path (AntigravityNative.generate -> runner build closure): a request whose
// systemInstruction carries tools.opencode.session_move must reach the (fake) runner as tools.agy.session_move
// with zero tools.opencode. occurrences, and a trigger-free request must pass byte-identical.
// UC2 drives the cell's map/merge path (AntigravityProvider.passthrough): a fake upstream answer carrying
// tools.agy.session_move must come back with tools.opencode.session_move restored, merged and per stream frame.
// NOTE on the split-token case: provider frames() renames each serialized frame self-contained (its rename buffer
// is flushed per frame, never carried across frames), and native map() restores per response, so no seam feeds a
// token split as "tools.ag"+"y." across a frame boundary at this tier. The streamed test below therefore restores
// a whole token per frame twice; the cross-chunk split stays covered by the unit test (reverseStreamChunk).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { MemoryLogger } from "@accounts-proxy/test-support/fakes.ts";
import { AntigravityNative } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-native.ts";
import { AntigravityProvider } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-provider.ts";
import { toModelDescriptors } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import type { StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import { innerRequest, prepareGeminiRequest } from "@accounts-proxy/provider-antigravity/domain/native-gemini.ts";
import { applyForwardAliases } from "@accounts-proxy/provider-antigravity/domain/namespace-alias.ts";
import type { TrajectorySnapshot } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";
import {
  AntigravityCatalogPort,
  AntigravityRunnerPort,
  AntigravityStatePort,
  type RunInput,
} from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

const catalogJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "plugin-5c6f7c2", "fetch-available-models.sample.json"), "utf8"),
) as Record<string, unknown>;
const descriptor = toModelDescriptors(catalogJson).find((d) => d.wireId === "gemini-3.6-flash-low")!;

class SampleCatalog extends AntigravityCatalogPort {
  private readonly descriptors = toModelDescriptors(catalogJson);
  override async listing() {
    return { source: "live" as const, descriptors: this.descriptors };
  }
  override async refresh() {
    return this.listing();
  }
  override async descriptor(wireId: string) {
    return this.descriptors.find((d) => d.wireId === wireId);
  }
}

class MemoryState extends AntigravityStatePort {
  override async sessionId() {
    return "-42";
  }
  override async signatures() {
    return {};
  }
  override async saveSignature(_id: string, _signature: string) {}
}

/** Local fake for the runner port: runs the cell's build closure over a fixed snapshot and maps scripted envelopes. */
class CaptureRunner extends AntigravityRunnerPort {
  readonly snapshots: TrajectorySnapshot[] = [];
  readonly built: unknown[] = [];
  constructor(private readonly envelopes: readonly StreamEnvelope[]) {
    super();
  }
  override async *run<T>(input: RunInput<T>): AsyncIterable<T> {
    const snapshot: TrajectorySnapshot = {
      requestId: "agent/uuid-1/77/uuid-2/3",
      sessionId: "-42",
      labels: {
        last_step_index: "3",
        model_enum: "MODEL_PLACEHOLDER_M73",
        trajectory_id: "uuid-1",
        used_claude: "false",
        used_claude_conservative: "false",
        used_non_gemini_model: "false",
      },
    };
    this.snapshots.push(snapshot);
    this.built.push(input.build(snapshot));
    for (const envelope of this.envelopes) yield input.map(envelope);
  }
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const decode = async (body: AsyncIterable<Uint8Array>): Promise<string[]> =>
  (await drain(body)).map((chunk) => new TextDecoder().decode(chunk));

const raw = (method: string, body: unknown, query: Record<string, string> = {}): RawRequest => ({
  format: "gemini",
  path: `/v1beta/models/antigravity/gemini-3.6-flash-low:${method}`,
  query,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
  lossy: false,
});

const hello = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

describe("namespace rename UC1 (forward, through the cell build path)", () => {
  test("a systemInstruction with tools.opencode.session_move reaches the runner as tools.agy.session_move", async () => {
    const prepared = prepareGeminiRequest(
      {
        ...hello,
        systemInstruction: { parts: [{ text: "Use tools.opencode.session_move to move it" }] },
      },
      descriptor,
      { lossy: false, signatures: {} },
    );
    const runner = new CaptureRunner([]);
    const logger = new MemoryLogger();
    const native = new AntigravityNative(runner, new MemoryState(), logger);
    expect(await drain(native.generate({ model: descriptor, prepared, signal: undefined }))).toEqual([]);
    expect(runner.built).toHaveLength(1);
    const bytes = JSON.stringify(runner.built[0]);
    expect(bytes).toContain("tools.agy.session_move");
    expect(bytes).not.toContain("tools.opencode.");
    // The bytes came out of the cell's build closure: forward(innerRequest) with no skip.
    expect(applyForwardAliases(innerRequest(prepared, runner.snapshots[0]!)).skipped).toBe(false);
    expect(runner.built[0]).toEqual(applyForwardAliases(innerRequest(prepared, runner.snapshots[0]!)).value);
    expect(logger.lines.some((line) => line.includes("already applied"))).toBe(false);
  });

  test("a trigger-free request passes byte-identical (no-op proof)", async () => {
    const prepared = prepareGeminiRequest({ ...hello }, descriptor, { lossy: false, signatures: {} });
    const runner = new CaptureRunner([]);
    const native = new AntigravityNative(runner, new MemoryState(), new MemoryLogger());
    expect(await drain(native.generate({ model: descriptor, prepared, signal: undefined }))).toEqual([]);
    expect(runner.built).toHaveLength(1);
    const bytes = JSON.stringify(runner.built[0]);
    expect(bytes).toContain('"text":"hi"');
    expect(bytes).not.toContain("tools.agy.");
    expect(bytes).toBe(JSON.stringify(innerRequest(prepared, runner.snapshots[0]!)));
  });
});

describe("namespace rename UC2 (reverse, through the cell map/merge path)", () => {
  const answer = (text: string): StreamEnvelope => ({
    response: {
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      responseId: "resp-1",
    },
  });
  const make = (envelopes: readonly StreamEnvelope[]) => {
    const runner = new CaptureRunner(envelopes);
    const logger = new MemoryLogger();
    return new AntigravityProvider(new SampleCatalog(), new AntigravityNative(runner, new MemoryState(), logger), logger);
  };

  test("a merged generateContent answer restores tools.opencode.session_move", async () => {
    const provider = make([answer("ran tools.agy.session_move ok")]);
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("generateContent", hello));
    expect(response.status).toBe(200);
    const merged = JSON.parse((await decode(response.body)).join("")) as unknown;
    const bytes = JSON.stringify(merged);
    expect(bytes).toContain("tools.opencode.session_move");
    expect(bytes).not.toContain("tools.agy.");
  });

  test("a two-frame stream restores a whole token per frame (split across frames stays unit-covered)", async () => {
    const provider = make([answer("first tools.agy.session_move done"), answer("second tools.agy.session_move done")]);
    const response = await provider.passthrough("gemini-3.6-flash-low", raw("streamGenerateContent", hello, { alt: "sse" }));
    expect(response.status).toBe(200);
    const frames = await decode(response.body);
    expect(frames).toHaveLength(2);
    const joined = frames.join("");
    expect(joined.split("tools.opencode.session_move")).toHaveLength(3);
    expect(joined).not.toContain("tools.agy.");
  });
});
