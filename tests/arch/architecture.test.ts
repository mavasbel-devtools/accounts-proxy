// Release-gate architecture law (AGENTS.md §2). Every import of every source file under
// packages/*/src and apps/*/src is resolved to a concrete file and checked against the layer matrix.
// Type-only imports are checked too: a type dependency is still a dependency.
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

type Workspace = { name: string; dir: string };

function workspaces(): Workspace[] {
  const found: Workspace[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, "package.json");
      if (!existsSync(manifest)) continue;
      found.push({ name: (JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name, dir: join(base, entry) });
    }
  }
  return found;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
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

function resolveImport(from: string, specifier: string, spaces: Workspace[]): string | "external" | undefined {
  const candidates = (base: string) => [base, `${base}.ts`, join(base, "index.ts")];
  if (specifier.startsWith(".")) {
    return candidates(resolve(dirname(from), specifier)).find((c) => existsSync(c) && statSync(c).isFile());
  }
  const workspace = spaces.find((w) => specifier === w.name || specifier.startsWith(`${w.name}/`));
  if (!workspace) return "external";
  const rest = specifier.slice(workspace.name.length + 1);
  if (rest === "") return undefined;
  return candidates(join(workspace.dir, "src", rest)).find((c) => existsSync(c) && statSync(c).isFile());
}

export function violations(): string[] {
  const spaces = workspaces();
  const problems: string[] = [];
  for (const space of spaces) {
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
      const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
      for (const imported of info.importedFiles) {
        const specifier = imported.fileName;
        const target = resolveImport(file, specifier, spaces);
        if (target === undefined) {
          problems.push(`${where}: unresolvable import ${specifier} (workspace imports need an explicit subpath)`);
        } else if (target === "external") {
          if (!EXTERNAL_ALLOWED.has(layer)) problems.push(`${where} [${layer}]: external import ${specifier} is forbidden`);
        } else {
          const targetLayer = layerOf(target);
          if (!targetLayer) problems.push(`${where}: import ${specifier} resolves outside every layer`);
          else if (!INTERNAL_ALLOWED[layer].includes(targetLayer)) {
            problems.push(`${where} [${layer}] -> ${relative(root, target)} [${targetLayer}] is forbidden`);
          }
        }
      }
    }
  }
  return problems;
}

describe("architecture law", () => {
  test("every workspace import respects the hexagonal layer matrix", () => {
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
});
