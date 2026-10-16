// Release-gate architecture law (AGENTS.md §2).
//  1. Layers: every import of every source file under packages/*/src and apps/*/src is resolved to a concrete file
//     and checked against the layer matrix. Type-only imports are checked too: a type dependency is a dependency.
//  2. Aliases: no relative import anywhere in the repository's own TypeScript (packages/*/{src,tests},
//     apps/*/{src,tests}, tests/, scripts/); the only exclusion is the byte-identical vendored parity references
//     (packages/*/tests/reference/**). Every `@inference-router/<workspace>/<subpath>` specifier must resolve to a
//     file through that workspace's `exports["./*"]`, and the importing workspace must be the target itself or
//     declare it (Bun 1.4.2's isolated linker links only declared workspace dependencies).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..", "..");

export type Layer =
  | "domain"
  | "ports-inbound"
  | "ports-outbound"
  | "application"
  | "adapters-inbound"
  | "adapters-outbound"
  | "composition"
  | "main";

const INTERNAL_ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  "ports-inbound": ["domain", "ports-inbound"],
  "ports-outbound": ["domain", "ports-outbound"],
  application: ["domain", "ports-inbound", "ports-outbound", "application"],
  "adapters-inbound": ["domain", "ports-inbound", "adapters-inbound"],
  "adapters-outbound": ["domain", "ports-outbound", "adapters-outbound"],
  composition: ["domain", "ports-inbound", "ports-outbound", "application", "adapters-inbound", "adapters-outbound", "composition"],
  main: ["composition"],
};

const EXTERNAL_ALLOWED: ReadonlySet<Layer> = new Set(["adapters-inbound", "adapters-outbound", "composition", "main"]);

/** A workspace package: its directory, the directory `exports["./*"]` maps to, and the workspaces it may import. */
export type Workspace = { name: string; dir: string; base: string; declared: ReadonlySet<string>; layered: boolean };

type Manifest = { name: string; workspaces?: string[]; exports?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
const declaredOf = (m: Manifest) => new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]);

export function workspaces(): Workspace[] {
  const dirs = (readManifest(root).workspaces ?? []).flatMap((pattern) =>
    pattern.endsWith("/*") ? readdirSync(join(root, pattern.slice(0, -2))).map((d) => join(root, pattern.slice(0, -2), d)) : [join(root, pattern)],
  );
  return dirs
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => {
      const m = readManifest(dir);
      const target = m.exports?.["./*"] ?? "./src/*";
      const group = relative(root, dir).split(sep)[0];
      return { name: m.name, dir, base: resolve(dir, target.replace(/\/\*$/, "")), declared: declaredOf(m), layered: group === "packages" || group === "apps" };
    });
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules") return [];
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

export function layerOf(file: string): Layer | undefined {
  const parts = relative(root, file).split(sep);
  const src = parts.indexOf("src");
  if (src !== 2 || (parts[0] !== "packages" && parts[0] !== "apps")) return undefined;
  const [first, second] = parts.slice(src + 1);
  if (first === "domain") return "domain";
  if (first === "application") return "application";
  if (first === "composition") return "composition";
  if (first === "main") return "main";
  if ((first === "ports" || first === "adapters") && (second === "inbound" || second === "outbound")) {
    return `${first}-${second}` as Layer;
  }
  return undefined;
}

const candidates = (base: string) => [base, `${base}.ts`, join(base, "index.ts")];
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** A resolved file, "external" for a non-workspace package, or undefined when a workspace specifier does not resolve. */
export function resolveImport(from: string, specifier: string, spaces: readonly Workspace[]): { file?: string; workspace?: Workspace } | "external" {
  if (specifier.startsWith(".")) {
    const file = candidates(resolve(dirname(from), specifier)).find(isFile);
    return file === undefined ? {} : { file };
  }
  const workspace = spaces.find((w) => specifier === w.name || specifier.startsWith(`${w.name}/`));
  if (!workspace) return "external";
  const rest = specifier.slice(workspace.name.length + 1);
  const file = rest === "" ? undefined : candidates(join(workspace.base, rest)).find(isFile);
  return file === undefined ? { workspace } : { file, workspace };
}

/** The workspace whose directory contains `file`, or undefined for root-level files (tests/arch). */
function ownerOf(file: string, spaces: readonly Workspace[]): Workspace | undefined {
  return [...spaces].sort((a, b) => b.dir.length - a.dir.length).find((w) => file.startsWith(w.dir + sep));
}

export function aliasScope(file: string): boolean {
  const p = relative(root, file).split(sep).join("/");
  if (/^packages\/[^/]+\/tests\/reference\//.test(p)) return false;
  return /^(packages|apps)\/[^/]+\/(src|tests)\//.test(p) || p.startsWith("tests/") || p.startsWith("scripts/");
}

/** Alias-law problems of one file's source (pure over the given text, so the gate can be tested on synthetic input). */
export function aliasProblems(file: string, source: string, spaces: readonly Workspace[]): string[] {
  const where = relative(root, file).split(sep).join("/");
  const owner = ownerOf(file, spaces);
  const rootDeclared = declaredOf(readManifest(root));
  const problems: string[] = [];
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    if (specifier.startsWith(".")) {
      problems.push(`${where}: relative import ${specifier} (use @inference-router/<workspace>/<subpath>)`);
      continue;
    }
    const resolved = resolveImport(file, specifier, spaces);
    if (resolved === "external") continue;
    if (resolved.file === undefined) {
      problems.push(`${where}: unresolvable import ${specifier} (workspace imports need an explicit subpath to an existing file)`);
      continue;
    }
    const target = resolved.workspace!;
    const declared = owner === undefined ? rootDeclared : owner.declared;
    if (owner?.name !== target.name && !declared.has(target.name)) {
      problems.push(`${where}: imports ${target.name} without declaring it in ${owner === undefined ? "the root" : owner.name} package.json`);
    }
  }
  return problems;
}

export function violations(): string[] {
  const spaces = workspaces();
  const problems: string[] = [];
  for (const space of spaces.filter((s) => s.layered)) {
    for (const tier of ["unit", "component", "live", "e2e"]) {
      if (!existsSync(join(space.dir, "tests", tier))) problems.push(`${space.name}: missing tests/${tier}`);
    }
    for (const file of walk(join(space.dir, "src"))) {
      const where = relative(root, file);
      const layer = layerOf(file);
      if (!layer) {
        problems.push(`${where}: not inside a known layer`);
        continue;
      }
      for (const imported of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
        const specifier = imported.fileName;
        const target = resolveImport(file, specifier, spaces);
        if (target === "external") {
          if (!EXTERNAL_ALLOWED.has(layer)) problems.push(`${where} [${layer}]: external import ${specifier} is forbidden`);
        } else if (target.file === undefined) {
          problems.push(`${where}: unresolvable import ${specifier} (workspace imports need an explicit subpath)`);
        } else {
          const targetLayer = layerOf(target.file);
          if (!targetLayer) problems.push(`${where}: import ${specifier} resolves outside every layer`);
          else if (!INTERNAL_ALLOWED[layer].includes(targetLayer)) {
            problems.push(`${where} [${layer}] -> ${relative(root, target.file)} [${targetLayer}] is forbidden`);
          }
        }
      }
    }
  }
  for (const file of [...walk(join(root, "packages")), ...walk(join(root, "apps")), ...walk(join(root, "tests")), ...walk(join(root, "scripts"))]) {
    if (aliasScope(file)) problems.push(...aliasProblems(file, readFileSync(file, "utf8"), spaces));
  }
  return problems;
}

describe("architecture law", () => {
  test("every workspace import respects the hexagonal layer matrix and the alias law", () => {
    expect(violations()).toEqual([]);
  });

  test("layerOf classifies every layer and rejects unknown placement", () => {
    const p = (...segments: string[]) => join(root, "packages", "core", "src", ...segments, "X.ts");
    expect(layerOf(p("domain"))).toBe("domain");
    expect(layerOf(p("ports", "inbound"))).toBe("ports-inbound");
    expect(layerOf(p("ports", "outbound"))).toBe("ports-outbound");
    expect(layerOf(p("application"))).toBe("application");
    expect(layerOf(p("adapters", "inbound"))).toBe("adapters-inbound");
    expect(layerOf(p("adapters", "outbound"))).toBe("adapters-outbound");
    expect(layerOf(p("composition"))).toBe("composition");
    expect(layerOf(p("main"))).toBe("main");
    expect(layerOf(p("adapters"))).toBeUndefined();
    expect(layerOf(p("misc"))).toBeUndefined();
    expect(layerOf(join(root, "tests", "x.ts"))).toBeUndefined();
  });

  test("the matrix forbids the dangerous directions", () => {
    expect(INTERNAL_ALLOWED["adapters-inbound"]).not.toContain("adapters-outbound");
    expect(INTERNAL_ALLOWED["adapters-outbound"]).not.toContain("adapters-inbound");
    expect(INTERNAL_ALLOWED.domain).toEqual(["domain"]);
    expect(INTERNAL_ALLOWED.application).not.toContain("adapters-inbound");
    expect(INTERNAL_ALLOWED.application).not.toContain("adapters-outbound");
    expect(EXTERNAL_ALLOWED.has("domain")).toBe(false);
    expect(EXTERNAL_ALLOWED.has("application")).toBe(false);
  });

  test("the alias law reports relative, unresolvable and undeclared imports (gate self-test)", () => {
    const spaces = workspaces();
    expect(spaces.map((s) => s.name).sort()).toEqual([
      "@inference-router/core",
      "@inference-router/dialect-anthropic",
      "@inference-router/dialect-gemini",
      "@inference-router/dialect-openai",
      "@inference-router/dialect-opencode",
      "@inference-router/provider-antigravity",
      "@inference-router/provider-cheaper-inference",
      "@inference-router/provider-claude",
      "@inference-router/provider-gateway",
      "@inference-router/provider-openai",
      "@inference-router/provider-opencode",
      "@inference-router/provider-openrouter",
      "@inference-router/router",
      "@inference-router/scripts",
      "@inference-router/test-support",
    ]);
    const coreTest = join(root, "packages", "core", "tests", "unit", "synthetic.test.ts");
    expect(aliasProblems(coreTest, 'import { x } from "../../src/domain/json.ts";', spaces)).toEqual([
      "packages/core/tests/unit/synthetic.test.ts: relative import ../../src/domain/json.ts (use @inference-router/<workspace>/<subpath>)",
    ]);
    expect(aliasProblems(coreTest, 'export * from "./sibling.ts";\nconst m = await import("../x.ts");', spaces)).toHaveLength(2);
    expect(aliasProblems(coreTest, 'import { x } from "@inference-router/core/domain/nope.ts";', spaces)[0]).toContain("unresolvable import");
    expect(aliasProblems(coreTest, 'import { x } from "@inference-router/core";', spaces)[0]).toContain("unresolvable import");
    expect(aliasProblems(coreTest, 'import { x } from "@inference-router/router/composition/container.ts";', spaces)).toEqual([
      "packages/core/tests/unit/synthetic.test.ts: imports @inference-router/router without declaring it in @inference-router/core package.json",
    ]);
    expect(aliasProblems(join(root, "tests", "arch", "synthetic.test.ts"), 'import "@inference-router/core/domain/json.ts";', spaces)[0]).toContain("without declaring it in the root package.json");
    expect(aliasProblems(coreTest, 'import { x } from "@inference-router/core/domain/json.ts";\nimport ts from "typescript";', spaces)).toEqual([]);
    const providerTest = join(root, "packages", "provider-claude", "tests", "unit", "synthetic.test.ts");
    expect(aliasProblems(providerTest, 'import { FixedClock } from "@inference-router/test-support/fakes.ts";', spaces)).toEqual([]);
  });

  test("alias scope: own code everywhere, never the vendored references", () => {
    expect(aliasScope(join(root, "packages", "core", "src", "domain", "x.ts"))).toBe(true);
    expect(aliasScope(join(root, "apps", "router", "tests", "unit", "x.ts"))).toBe(true);
    expect(aliasScope(join(root, "tests", "support", "fakes.ts"))).toBe(true);
    expect(aliasScope(join(root, "scripts", "gate", "verify.ts"))).toBe(true);
    expect(aliasScope(join(root, "packages", "provider-claude", "tests", "reference", "plugin-6292741", "domain", "x.ts"))).toBe(false);
    expect(aliasScope(join(root, "docs", "temp", "x.ts"))).toBe(false);
  });
});
