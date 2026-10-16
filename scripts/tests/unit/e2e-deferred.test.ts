// The R1 deferral mechanism of the e2e gate: whole files and single functions are removed from the e2e map, and every
// stale entry is a failure.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCoverageMap, type FileCoverageData } from "istanbul-lib-coverage";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { applyDeferrals, E2E_DEFERRED } from "@accounts-proxy/scripts/gate/e2e-deferred.ts";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) removeTemporary(root);
  root = undefined;
});

const SOURCE = ["export class P {", "  protected override live() {", "    return 1;", "  }", "  async *stream() {", "    yield (() => 2)();", "  }", "}", "export function twin() {}", "export function twin2() {}", ""].join("\n");
const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, column: c1 }, end: { line: l2, column: c2 } });

function fixture(hits: { live: number; stream: number; inner: number; branch: [number, number] }): { path: string; data: FileCoverageData } {
  root = makeTemporary("e2e-deferred");
  mkdirSync(join(root, "src"));
  const path = join(root, "src", "p.ts");
  writeFileSync(path, SOURCE);
  return {
    path,
    data: {
      path,
      statementMap: { "0": range(3, 4, 3, 13), "1": range(6, 4, 6, 23) },
      s: { "0": hits.live, "1": hits.stream },
      fnMap: {
        "0": { name: "(anonymous_0)", decl: range(2, 2, 2, 3), loc: range(2, 8, 4, 3), line: 2 },
        "1": { name: "(anonymous_1)", decl: range(5, 2, 5, 3), loc: range(5, 17, 7, 3), line: 5 },
        "2": { name: "(anonymous_2)", decl: range(6, 11, 6, 12), loc: range(6, 11, 6, 18), line: 6 },
        "3": { name: "twin", decl: range(9, 16, 9, 20), loc: range(9, 23, 9, 25), line: 9 },
      },
      f: { "0": hits.live, "1": hits.stream, "2": hits.inner, "3": 1 },
      branchMap: { "0": { type: "if", loc: range(6, 4, 6, 23), locations: [range(6, 4, 6, 10), range(6, 11, 6, 23)], line: 6 } },
      b: { "0": hits.branch },
    } as unknown as FileCoverageData,
  };
}

describe("applyDeferrals", () => {
  test("the committed list is empty or every entry names a phase and a reason", () => {
    for (const d of E2E_DEFERRED) expect([["P5", "P4.5-live", "P4.6-live"].includes(d.phase), d.reason.length > 0, d.file.endsWith(".ts")]).toEqual([true, true, true]);
  });

  test("a deferred method (resolved from its declaration) and everything nested in it leave the map", () => {
    const { path, data } = fixture({ live: 1, stream: 0, inner: 0, branch: [0, 0] });
    const result = applyDeferrals(createCoverageMap({ [path]: data }), [{ file: "src/p.ts", functions: ["stream"], phase: "P5", reason: "translated cells" }], root!);
    const left = result.map.fileCoverageFor(path).toJSON() as FileCoverageData;
    expect(Object.keys(left.fnMap)).toEqual(["0", "3"]);
    expect(Object.keys(left.statementMap)).toEqual(["0"]);
    expect(left.branchMap).toEqual({});
    expect(result.map.getCoverageSummary().toJSON().statements.pct).toBe(100);
    expect(result.notes).toEqual(["deferred src/p.ts [stream] (P5: translated cells)"]);
    expect(result.problems).toEqual([]);
  });

  test("a method declared with modifiers (protected override) is found by its name", () => {
    const { path, data } = fixture({ live: 0, stream: 1, inner: 1, branch: [1, 1] });
    const result = applyDeferrals(createCoverageMap({ [path]: data }), [{ file: "src/p.ts", functions: ["live"], phase: "P4.6-live", reason: "needs a capture" }], root!);
    expect([result.notes, result.problems]).toEqual([["deferred src/p.ts [live] (P4.6-live: needs a capture)"], []]);
  });

  test("a deferred file leaves the map and is exempt from completeness, loaded or not", () => {
    const { path, data } = fixture({ live: 0, stream: 0, inner: 0, branch: [0, 0] });
    const loaded = applyDeferrals(createCoverageMap({ [path]: data }), [{ file: "src/p.ts", phase: "P5", reason: "r" }], root!);
    expect(loaded.map.files()).toEqual([]);
    expect([...loaded.exemptFiles]).toEqual([path]);
    expect(loaded.notes).toEqual(["deferred file src/p.ts (P5: r)"]);
    const unloaded = applyDeferrals(createCoverageMap({}), [{ file: "src/p.ts", phase: "P5", reason: "r" }], root!);
    expect([[...unloaded.exemptFiles], unloaded.problems]).toEqual([[path], []]);
  });

  test("a deferred branch (named by its source line) leaves the map with its line's unrun statements; unknown, ambiguous or covered branch lines are stale", async () => {
    const { path, data } = fixture({ live: 0, stream: 0, inner: 1, branch: [1, 0] });
    const line = "yield (() => 2)();";
    const pristine = structuredClone(data);
    const result = applyDeferrals(createCoverageMap({ [path]: data }), [{ file: "src/p.ts", branches: [line], phase: "P5", reason: "r" }], root!);
    const kept = result.map.fileCoverageFor(path).toJSON() as FileCoverageData;
    expect([kept.branchMap, Object.keys(kept.statementMap), kept.s]).toEqual([{}, ["0"], { "0": 0 }]);
    expect([result.notes, result.problems]).toEqual([["deferred src/p.ts [branch `yield (() => 2)();`] (P5: r)"], []]);
    const again = () => createCoverageMap({ [path]: structuredClone(pristine) });
    expect(applyDeferrals(again(), [{ file: "src/p.ts", branches: ["nope"], phase: "P5", reason: "r" }], root!).problems).toEqual(["stale deferral: src/p.ts has 0 branches on a line `nope` (expected exactly one)"]);
    const covered = structuredClone(pristine) as unknown as { b: Record<string, number[]> };
    covered.b["0"] = [1, 1];
    expect(applyDeferrals(createCoverageMap({ [path]: covered as never }), [{ file: "src/p.ts", branches: [line], phase: "P5", reason: "r" }], root!).problems).toEqual([
      "stale deferral: src/p.ts branch `yield (() => 2)();` is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts",
    ]);
  });

  test("stale entries fail: fully covered file or function, unknown or ambiguous name, a function in an unloaded file", () => {
    const covered = fixture({ live: 1, stream: 1, inner: 1, branch: [1, 1] });
    const map = () => createCoverageMap({ [covered.path]: structuredClone(covered.data) });
    expect(applyDeferrals(map(), [{ file: "src/p.ts", phase: "P5", reason: "r" }], root!).problems).toEqual(["stale deferral: src/p.ts is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts"]);
    expect(applyDeferrals(map(), [{ file: "src/p.ts", functions: ["stream"], phase: "P5", reason: "r" }], root!).problems).toEqual([
      "stale deferral: src/p.ts stream is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts",
    ]);
    expect(applyDeferrals(map(), [{ file: "src/p.ts", functions: ["gone"], phase: "P5", reason: "r" }], root!).problems).toEqual([
      "stale deferral: src/p.ts has 0 functions named gone (expected exactly one)",
    ]);
    expect(applyDeferrals(createCoverageMap({}), [{ file: "src/p.ts", functions: ["stream"], phase: "P5", reason: "r" }], root!).problems).toEqual([
      "stale deferral: src/p.ts was not loaded by any e2e process; defer the whole file or remove the entry",
    ]);
    const twins = structuredClone(covered.data) as unknown as { fnMap: Record<string, unknown>; f: Record<string, number> };
    twins.fnMap["4"] = { name: "twin", decl: range(10, 16, 10, 21), loc: range(10, 24, 10, 26), line: 10 };
    twins.f["4"] = 0;
    expect(applyDeferrals(createCoverageMap({ [covered.path]: twins as never }), [{ file: "src/p.ts", functions: ["twin"], phase: "P5", reason: "r" }], root!).problems).toEqual([
      "stale deferral: src/p.ts has 2 functions named twin (expected exactly one)",
    ]);
  });
});
