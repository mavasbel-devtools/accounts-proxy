// Unit tests for the generated granularity check (plan 2026-11-15-23-52, step 7.1):
// synthetic designs and test texts only — the report scans packages/*/tests, apps/*/tests and tests/,
/// never scripts/tests/unit, so these fixtures cannot count as scenarios.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";
import {
  analyze,
  formatReport,
  GRANULARITY_DESIGNS,
  parseDesign,
  parseTags,
  type ScenarioTag,
} from "@accounts-proxy/scripts/gate/granularity-report.ts";

const DESIGN = [
  "### Feature `f` — the first feature",
  "",
  "#### uc-a — the first use case",
  "#### uc-b — the second use case",
  "",
  "### Feature `g` — the second feature",
  "",
  "#### uc-c — the third use case",
  "",
  "Dependencies per use case: uc-a → none; uc-b → `pi`; uc-c → `pi`, `dep`.",
  "",
].join("\n");

function tag(feature: string, useCase: string, tier: string, polarity: "positive" | "negative", _file: string, dependency?: string): string {
  const dep = dependency === undefined ? "" : ` dependency=${dependency}`;
  return `a scenario [feature=${feature} use-case=${useCase} tier=${tier}${dep} polarity=${polarity}]`;
}

function file(tags: string[]): { file: string; text: string } {
  return { file: "f.test.ts", text: tags.map((t) => `test("${t}", () => {});`).join("\n") };
}

function complete(): { file: string; text: string }[] {
  return [
    {
      file: "unit.test.ts",
      text: [
        `test("${tag("f", "uc-a", "unit", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-a", "unit", "negative", "")}", () => {});`,
        `test("${tag("f", "uc-b", "unit", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-b", "unit", "negative", "")}", () => {});`,
        `test("${tag("g", "uc-c", "unit", "positive", "")}", () => {});`,
        `test("${tag("g", "uc-c", "unit", "negative", "")}", () => {});`,
      ].join("\n"),
    },
    {
      file: "component.test.ts",
      text: [
        `test("${tag("f", "uc-a", "component", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-a", "component", "negative", "")}", () => {});`,
        `test("${tag("f", "uc-b", "component", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-b", "component", "negative", "")}", () => {});`,
        `test("${tag("g", "uc-c", "component", "positive", "")}", () => {});`,
        `test("${tag("g", "uc-c", "component", "negative", "")}", () => {});`,
      ].join("\n"),
    },
    {
      file: "e2e.test.ts",
      text: [
        `test("${tag("f", "uc-a", "e2e", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-a", "e2e", "negative", "")}", () => {});`,
        `test("${tag("f", "uc-b", "e2e", "positive", "")}", () => {});`,
        `test("${tag("f", "uc-b", "e2e", "negative", "")}", () => {});`,
        `test("${tag("g", "uc-c", "e2e", "positive", "")}", () => {});`,
        `test("${tag("g", "uc-c", "e2e", "negative", "")}", () => {});`,
      ].join("\n"),
    },
    {
      file: "live.test.ts",
      text: [
        `test("${tag("f", "uc-b", "live", "positive", "", "pi")}", () => {});`,
        `test("${tag("f", "uc-b", "live", "negative", "", "pi")}", () => {});`,
        `test("${tag("g", "uc-c", "live", "positive", "", "pi")}", () => {});`,
        `test("${tag("g", "uc-c", "live", "negative", "", "pi")}", () => {});`,
        `test("${tag("g", "uc-c", "live", "positive", "", "dep")}", () => {});`,
        `test("${tag("g", "uc-c", "live", "negative", "", "dep")}", () => {});`,
      ].join("\n"),
    },
  ];
}

function analyzeAll(sources: { file: string; text: string }[]) {
  return analyze(
    parseDesign(DESIGN),
    sources.flatMap((s) => parseTags(s.text, s.file)),
  );
}

describe("granularity report", () => {
  test("a complete matrix passes and counts every scenario [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    const analysis = analyzeAll(complete());
    expect(analysis.problems).toEqual([]);
    expect(analysis.rows).toHaveLength(3 + 3 + 3 + 1 + 2);
    expect(analysis.scenarioCount).toBe(24);
    expect(formatReport(analysis)).toContain("GRANULARITY: PASS (24 scenarios)");
  });

  test("a missing unit negative fails with its row [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete();
    sources[0] = {
      file: "unit.test.ts",
      text: sources[0]!.text
        .split("\n")
        .filter((line) => !line.includes("use-case=uc-a") || !line.includes("polarity=negative"))
        .join("\n"),
    };
    const analysis = analyzeAll(sources);
    expect(analysis.problems).toEqual(["missing [feature=f use-case=uc-a tier=unit dependency=none polarity=negative]"]);
    expect(formatReport(analysis)).toContain("GRANULARITY: FAIL (1 missing)");
  });

  test("a missing component pair fails with both rows [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete().filter((s) => s.file !== "component.test.ts");
    const analysis = analyzeAll(sources);
    expect(analysis.problems.filter((p) => p.includes("tier=component"))).toHaveLength(6);
    expect(analysis.problems).toContain("missing [feature=f use-case=uc-a tier=component dependency=none polarity=positive]");
  });

  test("component positive and negative in different files fail [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete().filter((s) => s.file !== "component.test.ts");
    sources.push({ file: "pos.test.ts", text: `test("${tag("f", "uc-a", "component", "positive", "")}", () => {});` });
    sources.push({ file: "neg.test.ts", text: `test("${tag("f", "uc-a", "component", "negative", "")}", () => {});` });
    const analysis = analyzeAll(sources);
    expect(analysis.problems).toContain(
      "component positive and negative for f uc-a are in different files (pos.test.ts vs neg.test.ts)",
    );
  });

  test("a missing e2e negative fails with its row [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete();
    sources[2] = {
      file: "e2e.test.ts",
      text: sources[2]!.text
        .split("\n")
        .filter((line) => !line.includes("uc-a") || !line.includes("polarity=negative"))
        .join("\n"),
    };
    const analysis = analyzeAll(sources);
    expect(analysis.problems).toContain("missing [feature=f use-case=uc-a tier=e2e dependency=none polarity=negative]");
  });

  test("a missing live dependency fails with both polarities [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete().filter((s) => s.file !== "live.test.ts");
    const analysis = analyzeAll(sources);
    expect(analysis.problems).toContain("missing [feature=f use-case=uc-b tier=live dependency=pi polarity=positive]");
    expect(analysis.problems).toContain("missing [feature=f use-case=uc-b tier=live dependency=pi polarity=negative]");
    expect(analysis.problems).toContain("missing [feature=g use-case=uc-c tier=live dependency=dep polarity=positive]");
    expect(analysis.problems.filter((p) => p.includes("tier=live"))).toHaveLength(6);
  });

  test("a tag naming an unknown feature fails [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete();
    sources.push(file([tag("nope", "uc-a", "unit", "positive", "")]));
    const analysis = analyzeAll(sources);
    expect(analysis.problems.some((p) => p.startsWith("unknown feature"))).toBe(true);
  });

  test("a tag naming an unknown use case fails [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete();
    sources.push(file([tag("f", "uc-zzz", "unit", "positive", "")]));
    const analysis = analyzeAll(sources);
    expect(analysis.problems.some((p) => p.startsWith("unknown use case"))).toBe(true);
  });

  test("a tag naming an unknown tier fails [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const tags: ScenarioTag[] = [
      { feature: "f", useCase: "uc-a", tier: "smoke", dependency: "none", polarity: "positive", file: "x.test.ts" },
    ];
    const analysis = analyze(parseDesign(DESIGN), tags);
    expect(analysis.problems.some((p) => p.startsWith("unknown tier"))).toBe(true);
  });

  test("a tag naming an unknown dependency fails [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const sources = complete();
    sources.push(file([tag("g", "uc-c", "live", "positive", "", "nope")]));
    const analysis = analyzeAll(sources);
    expect(analysis.problems.some((p) => p.startsWith("unknown dependency"))).toBe(true);
  });

  test("the plan's design parses to three features, seven use cases and the live matrix [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(GRANULARITY_DESIGNS).toEqual(["docs/design/2026-11-15-23-52-pi-compatibility-product.md"]);
    const design = parseDesign(readFileSync(join(repositoryRoot, GRANULARITY_DESIGNS[0]!), "utf8"));
    expect(design.features.map((f) => f.id)).toEqual(["pi-config", "pi-extension", "pi-inference"]);
    expect(design.features.flatMap((f) => f.useCases)).toEqual(["uc-pi-1", "uc-pi-2", "uc-pi-3", "uc-pi-4", "uc-pi-6", "uc-pi-5", "uc-pi-7"]);
    expect(design.dependencies.get("uc-pi-1")).toEqual(["none"]);
    expect(design.dependencies.get("uc-pi-4")).toEqual(["pi"]);
    expect(design.dependencies.get("uc-pi-5")).toEqual([
      "pi",
      "claude",
      "antigravity",
      "openai",
      "openrouter",
      "opencode",
      "opencode-go",
      "cheaper-inference",
    ]);
    expect(design.dependencies.get("uc-pi-7")).toEqual(["none"]);
  });
});
