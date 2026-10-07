// P3 parity gate for provider-antigravity: the ported pure domain must produce exactly what
// opencode-antigravity-auth @ 5c6f7c2 produces (tests/reference/plugin-5c6f7c2, MANIFEST.json lists source blobs).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { advertisedContextWindow, excludedModelIds, thinkingDefaultFor, toModelDescriptors } from "@inference-router/provider-antigravity/domain/catalog.ts";
import { GenerateCodec, sanitizeSchema, toWireTools, type ChatRequest, type StreamEnvelope } from "@inference-router/provider-antigravity/domain/generate.ts";
import { extractProjectIds } from "@inference-router/provider-antigravity/domain/project.ts";
import { formatUsage, lowestRemaining, parseGroupModels, toQuotaSnapshot } from "@inference-router/provider-antigravity/domain/quota.ts";
import { mintSessionId, TrajectoryState } from "@inference-router/provider-antigravity/domain/trajectory.ts";

const ref = join(import.meta.dir, "..", "reference", "plugin-5c6f7c2", "domain");
const load = async <T>(path: string): Promise<T> => (await import(join(ref, path))) as T;
// Reference modules are loaded untyped on purpose: their source is excluded from this repository's typecheck.
type Any = any;
const R = {
  transform: await load<Any>("services/RequestTransformService.ts"),
  trajectory: await load<Any>("services/TrajectoryStateService.ts"),
  catalog: await load<Any>("services/ModelCatalogService.ts"),
  project: await load<Any>("services/ProjectResolver.ts"),
  quota: await load<Any>("services/QuotaService.ts"),
};

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-5c6f7c2");
const models = JSON.parse(readFileSync(join(fixtures, "fetch-available-models.sample.json"), "utf8")) as Record<string, unknown>;
const quota = JSON.parse(readFileSync(join(fixtures, "retrieve-user-quota-summary.sample.json"), "utf8")) as Record<string, unknown>;
const sse = readFileSync(join(fixtures, "stream-generate.sample.sse"), "utf8");
const envelopes = sse
  .split("\n")
  .filter((l) => l.startsWith("data:"))
  .map((l) => JSON.parse(l.slice(5)) as StreamEnvelope);

const counter = () => {
  let n = 0;
  return () => `u-${++n}`;
};

describe("catalog parity", () => {
  test("descriptors, exclusions, thinking defaults, advertised windows over the captured catalog", () => {
    const ours = toModelDescriptors(models);
    expect(ours).toEqual(R.catalog.toModelDescriptors(models));
    expect(excludedModelIds(models)).toEqual(R.catalog.excludedModelIds(models));
    for (const d of ours) {
      expect(thinkingDefaultFor(d)).toBe(R.catalog.thinkingDefaultFor(d));
      expect(advertisedContextWindow(d)).toBe(R.catalog.advertisedContextWindow(d));
    }
  });
  test.each([
    [{}],
    [{ models: { a: { displayName: "Same" }, b: { displayName: "Same" }, c: {} } }],
    [{ models: { a: { quotaInfo: { remainingFraction: 1 } } }, tabModelIds: "x", deprecatedModelIds: ["y"] }],
    [{ models: {}, deprecatedModelIds: { d: null, e: { newModelId: 7 } } }],
    [{ models: { t: {}, k: {} }, tabModelIds: ["t", 5] }],
  ])("edge catalog %p", (raw) => {
    expect(toModelDescriptors(raw)).toEqual(R.catalog.toModelDescriptors(raw));
    expect(excludedModelIds(raw)).toEqual(R.catalog.excludedModelIds(raw));
  });
});

describe("project and quota parity", () => {
  test.each([
    [{ projectId: "p1", cloudaicompanionProject: "p2", allowedProjects: ["p1", { id: "p3" }, { id: "" }, null, 5], projects: "no" }],
    [{ projects: [{ id: "q" }, ""] }],
    [{}],
  ])("extractProjectIds %p", (raw) => {
    expect(extractProjectIds(raw)).toEqual(R.project.extractProjectIds(raw));
  });
  test("quota snapshot, usage view, group models, lowest remaining", () => {
    const ours = toQuotaSnapshot(quota, 42);
    expect(ours).toEqual(R.quota.toQuotaSnapshot(quota, 42));
    expect(formatUsage(ours)).toEqual(R.quota.formatUsage(ours));
    expect(lowestRemaining(ours)).toBe(R.quota.lowestRemaining(ours));
    for (const d of [undefined, "", "no colon", "Models within this group: A, B ,, C"]) expect(parseGroupModels(d)).toEqual(R.quota.parseGroupModels(d));
    const odd = { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.123 }, {}] }, { description: "" }] };
    expect(formatUsage(toQuotaSnapshot(odd, 1))).toEqual(R.quota.formatUsage(R.quota.toQuotaSnapshot(odd, 1)));
    expect(lowestRemaining(toQuotaSnapshot({}, 1))).toBe(R.quota.lowestRemaining(R.quota.toQuotaSnapshot({}, 1)));
  });
});

describe("trajectory parity", () => {
  test("mintSessionId is the same FNV-1a int64 decimal string", () => {
    for (const seed of ["a", "8f1c2d3e-0000-4000-8000-000000000000", ""]) {
      expect(mintSessionId(() => seed)).toBe(R.trajectory.mintSessionId({ uuid: () => seed }));
    }
  });

  test("snapshot sequence over a multi-turn, tool-loop, model-switch, new-conversation scenario", () => {
    const refUuid = counter();
    const ourUuid = counter();
    const now = () => 1_790_000_000_000;
    const reference = new R.trajectory.TrajectoryStateService({ random: { uuid: refUuid }, clock: { now }, identity: { load: () => "-123456789012345678", save: () => {} } });
    const ours = new TrajectoryState({ sessionUuid: ourUuid(), sessionId: "-123456789012345678", uuid: ourUuid, now });
    const u = (text: string) => ({ role: "user" as const, text });
    const a = (text: string) => ({ role: "assistant" as const, text });
    const t = { role: "tool" as const, text: "out", toolCallId: "c1", toolName: "ls" };
    const steps: [string, string, Parameters<TrajectoryState["begin"]>[2], boolean][] = [
      ["gemini-3.6-flash-low", "MODEL_PLACEHOLDER_M73", [u("hi")], true],
      ["gemini-3.6-flash-low", "MODEL_PLACEHOLDER_M73", [u("hi"), a("x"), t], true],
      ["claude-sonnet-5", "MODEL_X", [u("hi"), a("x"), t, a("y"), u("more")], true],
      ["claude-sonnet-5", "MODEL_X", [u("hi"), a("x"), t, a("y"), u("more")], false],
      ["gpt-oss-120b", "MODEL_G", [u("hi"), a("x"), t, a("y"), u("more"), a("z"), t], true],
      ["gemini-3.6-flash-low", "M", [u("other topic")], true],
      ["gemini-3.6-flash-low", "M", [], true],
      ["gemini-3.6-flash-low", "M", [a("no user")], true],
    ];
    for (const [model, modelEnum, messages, complete] of steps) {
      expect(ours.begin(model, modelEnum, messages)).toEqual(reference.begin(model, modelEnum, messages));
      if (complete) {
        ours.complete();
        reference.complete();
      }
    }
    const fresh = new TrajectoryState({ sessionUuid: "s", sessionId: "1", uuid: ourUuid, now });
    expect(() => fresh.complete()).not.toThrow();
  });
});

describe("generate parity", () => {
  const tools = [
    { name: "ls", description: "list", parameters: { $schema: "x", type: "object", additionalProperties: false, properties: { path: { type: "string", exclusiveMinimum: 1 }, n: { type: ["integer", "null"], nullable: true } }, required: ["path"] } },
    { name: "noop" },
  ];
  const requests: [string, ChatRequest][] = [
    ["plain", { modelWireId: "gemini-3.6-flash-low", messages: [{ role: "user", text: "hi" }] }],
    [
      "system, images, tools, thinking, max tokens",
      {
        modelWireId: "claude-sonnet-5",
        maxOutputTokens: 64000,
        thinkingBudget: 1024,
        tools,
        modelEnum: "MODEL_X",
        messages: [
          { role: "system", text: "be brief" },
          { role: "system", text: "   " },
          { role: "user", text: "look", images: [{ mimeType: "image/png", base64: "AA" }] },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "ls", arguments: '{"path":"."}' }, { id: "c2", name: "noop", arguments: "" }, { id: "c3", name: "ls", arguments: "{bad" }] },
          { role: "tool", text: "out", toolCallId: "c1", toolName: "ls" },
          { role: "tool", text: "out2", toolCallId: "c2" },
          { role: "tool", text: "out3" },
          { role: "assistant", text: "trailing" },
        ],
      },
    ],
    [
      "gemini: signed call kept, unsigned calls dropped with their results, then trailing model turn stripped",
      {
        modelWireId: "gemini-3.7-flash-tiered",
        messages: [
          { role: "user", text: "go" },
          { role: "assistant", text: "", toolCalls: [{ id: "signed", name: "ls", arguments: "{}" }] },
          { role: "tool", text: "r1", toolCallId: "signed", toolName: "ls" },
          { role: "assistant", text: "partly", toolCalls: [{ id: "signed", name: "ls", arguments: "{}" }, { id: "lost", name: "ls", arguments: "{}" }] },
          { role: "tool", text: "r2", toolCallId: "lost", toolName: "ls" },
          { role: "assistant", text: "", toolCalls: [{ id: "gone", name: "ls", arguments: "{}" }] },
          { role: "assistant", text: "keeps text", toolCalls: [{ id: "gone2", name: "ls", arguments: "{}" }] },
          { role: "tool", text: "r3", toolCallId: "gone2" },
        ],
      },
    ],
  ];

  for (const [name, request] of requests) {
    test(name, () => {
      const refWarnings: string[] = [];
      const ourWarnings: string[] = [];
      const reference = new R.transform.RequestTransformService({ signaturesStore: { readAll: () => ({ signed: "sig-1" }), upsert: () => {} }, logger: { warn: (m: string) => refWarnings.push(m) } });
      const ours = new GenerateCodec({ signed: "sig-1" }, { warn: (m) => ourWarnings.push(m) });
      const opts = { labels: { last_step_index: "2", model_enum: "M", trajectory_id: "t", used_claude: "false", used_claude_conservative: "false", used_non_gemini_model: "false" }, sessionId: "-1" };
      expect(JSON.stringify(ours.toGenerateBody(request, opts))).toBe(JSON.stringify(reference.toGenerateBody(request, opts)));
      expect(JSON.stringify(ours.toGenerateBody(request, { labels: opts.labels }))).toBe(JSON.stringify(reference.toGenerateBody(request, { labels: opts.labels })));
      expect(ourWarnings).toEqual(refWarnings);
    });
  }

  test("schema sanitizer and wire tools", () => {
    expect(toWireTools(tools)).toEqual(R.transform.toWireTools(tools));
    expect(toWireTools([])).toEqual(R.transform.toWireTools([]));
    expect(sanitizeSchema(tools[0]!.parameters)).toEqual(toWireTools([tools[0]!])[0]!.functionDeclarations[0]!["parameters"] as never);
  });

  test("envelopeToChunk over the captured stream and synthetic envelopes; captured signatures are replayed", () => {
    const refStored: Record<string, string> = {};
    const ourStored: Record<string, string> = {};
    const reference = new R.transform.RequestTransformService({ signaturesStore: { readAll: () => ({}), upsert: (k: string, v: string) => (refStored[k] = v) } });
    const ours = new GenerateCodec({}, { onSignature: (k, v) => (ourStored[k] = v) });
    const synthetic: StreamEnvelope[] = [
      {},
      { response: {} },
      { response: { candidates: [{ content: { parts: [{ functionCall: { id: "f1", name: "ls", args: { p: 1 } }, thoughtSignature: "S1" }, { functionCall: { name: "noid" } }, { thought: true, text: "think" }, { thought: true, text: "" }, { text: "" }, { text: "out" }] }, finishReason: "STOP" }], usageMetadata: { cachedContentTokenCount: 3 } } },
      { response: { candidates: [], usageMetadata: {} } },
      { response: { candidates: [{ content: { parts: [{ functionCall: { name: "first-without-id" } }] } }] } },
    ];
    expect(new GenerateCodec().envelopeToChunk(synthetic[4]!)).toEqual(reference.envelopeToChunk(synthetic[4]!));
    for (const env of [...envelopes, ...synthetic]) expect(ours.envelopeToChunk(env)).toEqual(reference.envelopeToChunk(env));
    expect(ourStored).toEqual(refStored);
    const replay: ChatRequest = { modelWireId: "gemini-x", messages: [{ role: "user", text: "q" }, { role: "assistant", text: "", toolCalls: [{ id: "f1", name: "ls", arguments: "{}" }] }, { role: "tool", text: "r", toolCallId: "f1", toolName: "ls" }] };
    const labels = { last_step_index: "2", model_enum: "M", trajectory_id: "t", used_claude: "false", used_claude_conservative: "false", used_non_gemini_model: "false" };
    expect(JSON.stringify(ours.toGenerateBody(replay, { labels }))).toBe(JSON.stringify(reference.toGenerateBody(replay, { labels })));
    expect(JSON.stringify(ours.toGenerateBody(replay, { labels }))).toContain('"thoughtSignature":"S1"');
  });
});
