// Generated granularity check (user global AGENTS.md 6.7; plan 2026-11-15-23-52, stage 7):
// coverage of features, use cases, dependencies and negative paths is counted from scenario tags, never by hand.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";

export const GRANULARITY_DESIGNS = ["docs/design/2026-11-15-23-52-pi-compatibility-product.md"];

export const KNOWN_TIERS = ["unit", "component", "e2e", "live"] as const;

export interface DesignModel {
  features: { id: string; useCases: string[] }[];
  dependencies: Map<string, string[]>;
}

export function parseDesign(markdown: string): DesignModel {
  const features: { id: string; useCases: string[] }[] = [];
  for (const line of markdown.split("\n")) {
    const feature = /^### Feature `([^`]+)`/.exec(line);
    if (feature !== null) {
      features.push({ id: feature[1]!, useCases: [] });
      continue;
    }
    const useCase = /^#### (uc-[A-Za-z0-9-]+)/.exec(line);
    if (useCase !== null && features.length > 0) features[features.length - 1]!.useCases.push(useCase[1]!);
  }
  const dependencies = new Map<string, string[]>();
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.includes("Dependencies per use case"));
  if (start >= 0) {
    const paragraph: string[] = [];
    for (const line of lines.slice(start)) {
      if (line.trim() === "") break;
      paragraph.push(line);
    }
    for (const chunk of paragraph.join(" ").split(";")) {
      const arrow = chunk.includes("→") ? "→" : "->";
      const parts = chunk.split(arrow);
      if (parts.length !== 2) continue;
      const ucs = parts[0]!.match(/uc-[A-Za-z0-9-]+/g) ?? [];
      const right = parts[1]!;
      const deps = /\bnone\b/.test(right) ? ["none"] : [...right.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      for (const uc of ucs) dependencies.set(uc, deps);
    }
  }
  return { features, dependencies };
}

export interface ScenarioTag {
  feature: string;
  useCase: string;
  tier: string;
  dependency: string;
  polarity: "positive" | "negative";
  file: string;
}

const TAG = /\[feature=([^\s\]]+)\s+use-case=([^\s\]]+)\s+tier=([^\s\]]+)(?:\s+dependency=([^\s\]]+))?\s+polarity=(positive|negative)\]/g;

export function parseTags(source: string, file: string): ScenarioTag[] {
  const tags: ScenarioTag[] = [];
  for (const match of source.matchAll(TAG)) {
    tags.push({
      feature: match[1]!,
      useCase: match[2]!,
      tier: match[3]!,
      dependency: match[4] ?? "none",
      polarity: match[5] as "positive" | "negative",
      file,
    });
  }
  return tags;
}

export interface GranularityRow {
  feature: string;
  useCase: string;
  tier: string;
  dependency: string;
  positive: boolean;
  negative: boolean;
}

export interface Analysis {
  rows: GranularityRow[];
  problems: string[];
  scenarioCount: number;
}

function tagLabel(tag: ScenarioTag): string {
  const dependency = tag.tier === "live" || tag.dependency !== "none" ? ` dependency=${tag.dependency}` : "";
  return `[feature=${tag.feature} use-case=${tag.useCase} tier=${tag.tier}${dependency} polarity=${tag.polarity}] in ${tag.file}`;
}

export function analyze(design: DesignModel, tags: ScenarioTag[]): Analysis {
  const knownFeatures = new Map(design.features.map((f) => [f.id, f]));
  const knownDependencies = new Set<string>(["none"]);
  for (const deps of design.dependencies.values()) for (const dep of deps) knownDependencies.add(dep);

  const problems: string[] = [];
  const valid: ScenarioTag[] = [];
  for (const tag of tags) {
    const feature = knownFeatures.get(tag.feature);
    if (feature === undefined) {
      problems.push(`unknown feature in tag: ${tagLabel(tag)}`);
      continue;
    }
    if (!feature.useCases.includes(tag.useCase)) {
      problems.push(`unknown use case in tag: ${tagLabel(tag)}`);
      continue;
    }
    if (!(KNOWN_TIERS as readonly string[]).includes(tag.tier)) {
      problems.push(`unknown tier in tag: ${tagLabel(tag)}`);
      continue;
    }
    if (!knownDependencies.has(tag.dependency)) {
      problems.push(`unknown dependency in tag: ${tagLabel(tag)}`);
      continue;
    }
    valid.push(tag);
  }

  const rows: GranularityRow[] = [];
  for (const feature of design.features) {
    for (const useCase of feature.useCases) {
      const dependencies = design.dependencies.get(useCase) ?? ["none"];
      const expected: { tier: string; dependency: string }[] = [
        { tier: "unit", dependency: "none" },
        { tier: "component", dependency: "none" },
        { tier: "e2e", dependency: "none" },
      ];
      for (const dependency of dependencies) {
        if (dependency !== "none") expected.push({ tier: "live", dependency });
      }
      for (const { tier, dependency } of expected) {
        const matching =
          tier === "live"
            ? valid.filter((tag) => tag.feature === feature.id && tag.useCase === useCase && tag.tier === tier && tag.dependency === dependency)
            : valid.filter(
                (tag) => tag.feature === feature.id && tag.useCase === useCase && tag.tier === tier && tag.dependency === "none",
              );
        const positiveFiles = [...new Set(matching.filter((tag) => tag.polarity === "positive").map((tag) => tag.file))];
        const negativeFiles = [...new Set(matching.filter((tag) => tag.polarity === "negative").map((tag) => tag.file))];
        const row: GranularityRow = {
          feature: feature.id,
          useCase,
          tier,
          dependency,
          positive: positiveFiles.length > 0,
          negative: negativeFiles.length > 0,
        };
        rows.push(row);
        if (!row.positive) problems.push(`missing [feature=${feature.id} use-case=${useCase} tier=${tier} dependency=${dependency} polarity=positive]`);
        if (!row.negative) problems.push(`missing [feature=${feature.id} use-case=${useCase} tier=${tier} dependency=${dependency} polarity=negative]`);
        if (tier === "component" && row.positive && row.negative && positiveFiles.every((file) => !negativeFiles.includes(file))) {
          problems.push(
            `component positive and negative for ${feature.id} ${useCase} are in different files (${positiveFiles.join(", ")} vs ${negativeFiles.join(", ")})`,
          );
        }
      }
    }
  }

  for (const tag of valid) {
    const row = rows.find(
      (r) =>
        r.feature === tag.feature &&
        r.useCase === tag.useCase &&
        r.tier === tag.tier &&
        (tag.tier === "live" ? r.dependency === tag.dependency : tag.dependency === "none"),
    );
    if (row === undefined) problems.push(`tag matches no expected row: ${tagLabel(tag)}`);
  }

  return { rows, problems, scenarioCount: tags.length };
}

export function formatReport(analysis: Analysis): string {
  const lines = ["feature | use case | tier | dependency | positive | negative"];
  for (const row of analysis.rows) {
    lines.push(
      `${row.feature} | ${row.useCase} | ${row.tier} | ${row.dependency} | ${row.positive ? "yes" : "no"} | ${row.negative ? "yes" : "no"}`,
    );
  }
  for (const problem of analysis.problems) lines.push(problem);
  lines.push(
    analysis.problems.length === 0
      ? `GRANULARITY: PASS (${analysis.scenarioCount} scenarios)`
      : `GRANULARITY: FAIL (${analysis.problems.length} missing)`,
  );
  return lines.join("\n");
}

function collectTestFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") collectTestFiles(full, out);
    } else if (entry.endsWith(".test.ts")) out.push(full);
  }
}

if (import.meta.main) {
  const designs: DesignModel[] = [];
  for (const design of GRANULARITY_DESIGNS) {
    const path = join(repositoryRoot, design);
    if (!existsSync(path)) {
      console.error(`GRANULARITY: FAIL (design not found: ${design})`);
      process.exit(2);
    }
    designs.push(parseDesign(readFileSync(path, "utf8")));
  }
  const merged: DesignModel = {
    features: designs.flatMap((d) => d.features),
    dependencies: new Map(designs.flatMap((d) => [...d.dependencies])),
  };
  const files: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(repositoryRoot, group);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base)) collectTestFiles(join(base, workspace, "tests"), files);
  }
  collectTestFiles(join(repositoryRoot, "tests"), files);
  const tags = files.flatMap((file) => parseTags(readFileSync(file, "utf8"), file));
  const analysis = analyze(merged, tags);
  console.log(formatReport(analysis));
  process.exit(analysis.problems.length === 0 ? 0 : 1);
}
