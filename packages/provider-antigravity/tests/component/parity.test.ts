// P3 parity gate for provider-antigravity: the ported pure domain must produce exactly what
// opencode-antigravity-auth @ ba0ae60 produces (tests/reference/plugin-ba0ae60, MANIFEST.json lists source blobs).
// ba0ae60 replaced 5c6f7c2 when the plugin's 80k advertised-window clamp was retired (plan 2026-11-02-21-29).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { excludedModelIds, thinkingDefaultFor, toModelDescriptors } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import { sanitizeSchema } from "@accounts-proxy/provider-antigravity/domain/gemini-schema.ts";
import { extractProjectIds } from "@accounts-proxy/provider-antigravity/domain/project.ts";
import { formatUsage, parseGroupModels, toQuotaSnapshot } from "@accounts-proxy/provider-antigravity/domain/quota.ts";
import { mintSessionId, TrajectoryState } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";

const ref = join(import.meta.dir, "..", "reference", "plugin-ba0ae60", "domain");
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
const liveText: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "tests", "fixtures", "captures", "p0-live", "e5", "fetch-available-models.json"), "utf8")).exchanges[0].response.chunks.map((c: { text: string }) => c.text).join("");
const live = JSON.parse(liveText) as Record<string, unknown>;
const quota = JSON.parse(readFileSync(join(fixtures, "retrieve-user-quota-summary.sample.json"), "utf8")) as Record<string, unknown>;

const counter = () => {
  let n = 0;
  return () => `u-${++n}`;
};

describe("catalog parity", () => {
  test("descriptors, exclusions and thinking defaults over the captured catalogs", () => {
    // The proxy keeps the catalog's true MIME types as `mimeTypes` in catalog order, omitted when none (plan 2026-10-16
    // C3); the plugin keeps them as `supportedMimeTypes`, sorted, empty when none. Every other field is identical.
    for (const raw of [models, live]) {
      const ours = toModelDescriptors(raw);
      const plugin = R.catalog.toModelDescriptors(raw) as { supportedMimeTypes: string[] }[];
      expect(ours.map(({ mimeTypes: _, ...d }) => d) as object[]).toEqual(plugin.map(({ supportedMimeTypes: _, ...d }) => d));
      expect(ours.map((d) => [...(d.mimeTypes ?? [])].sort())).toEqual(plugin.map((d) => d.supportedMimeTypes));
      for (const d of ours) expect(thinkingDefaultFor(d)).toBe(R.catalog.thinkingDefaultFor(d));
    }
    expect(toModelDescriptors(live).find((d) => d.wireId === "gemini-3.6-flash-medium")?.mimeTypes).toContain("application/pdf");
    expect(excludedModelIds(models)).toEqual(R.catalog.excludedModelIds(models));
  });
  test.each([
    [{}],
    [{ models: { a: { displayName: "Same" }, b: { displayName: "Same" }, c: {} } }],
    [{ models: { a: { quotaInfo: { remainingFraction: 1 } } }, tabModelIds: "x", deprecatedModelIds: ["y"] }],
    [{ models: {}, deprecatedModelIds: { d: null, e: { newModelId: 7 } } }],
    [{ models: { t: {}, k: {} }, tabModelIds: ["t", 5] }],
  ])("edge catalog %p", (raw) => {
    const plugin = R.catalog.toModelDescriptors(raw) as { supportedMimeTypes: string[] }[];
    expect(toModelDescriptors(raw) as object[]).toEqual(plugin.map(({ supportedMimeTypes: _, ...d }) => d));
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
    for (const d of [undefined, "", "no colon", "Models within this group: A, B ,, C"]) expect(parseGroupModels(d)).toEqual(R.quota.parseGroupModels(d));
    const odd = { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.123 }, {}] }, { description: "" }] };
    expect(formatUsage(toQuotaSnapshot(odd, 1))).toEqual(R.quota.formatUsage(R.quota.toQuotaSnapshot(odd, 1)));
    expect(formatUsage(toQuotaSnapshot({}, 1))).toEqual(R.quota.formatUsage(R.quota.toQuotaSnapshot({}, 1)));
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
      ["gemini-3.6-flash-low", "M", [a("no user")], true],
    ];
    for (const [model, modelEnum, messages, complete] of steps) {
      expect(ours.begin(model, modelEnum, messages)).toEqual(reference.begin(model, modelEnum, messages));
      if (complete) {
        ours.complete();
        reference.complete();
      }
    }
  });
});

describe("tool schema parity (law 5)", () => {
  const tools = [
    { name: "ls", description: "list", parameters: { $schema: "x", type: "object", additionalProperties: false, properties: { path: { type: "string", exclusiveMinimum: 1 }, n: { type: ["integer", "null"], nullable: true } }, required: ["path"] } },
    { name: "noop" },
  ];

  test("the sanitized schema is the plugin's wire tool parameters", () => {
    expect(sanitizeSchema(tools[0]!.parameters)).toEqual(R.transform.toWireTools([tools[0]!])[0].functionDeclarations[0].parameters);
  });
});
