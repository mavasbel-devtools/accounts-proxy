// One-off codemod (alias-imports plan, step 3): rewrite every relative import specifier in the repository's own
// TypeScript into the owning workspace's package name, `@inference-router/<workspace>/<subpath>`.
// Scope: packages/*/{src,tests}, apps/*/{src,tests}, tests/, scripts/ — excluding vendored parity references
// (packages/*/tests/reference/**), node_modules and docs/temp. Only the string literal of each specifier changes.
// A target that no workspace "exports" maps is a hard error (nothing is guessed).
// Usage: bun scripts/evidence/alias-imports.ts [--dry-run]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..", "..");
const dryRun = process.argv.includes("--dry-run");

type Workspace = { name: string; base: string };

/** Every workspace with its `exports["./*"]` base directory (e.g. packages/core/src, tests/support). */
function workspaces(): Workspace[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces: string[] };
  const dirs = manifest.workspaces.flatMap((pattern) =>
    pattern.endsWith("/*") ? readdirSync(join(root, pattern.slice(0, -2))).map((d) => join(root, pattern.slice(0, -2), d)) : [join(root, pattern)],
  );
  return dirs
    .filter((d) => existsSync(join(d, "package.json")))
    .map((d) => {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name: string; exports?: Record<string, string> };
      const target = pkg.exports?.["./*"];
      if (target === undefined || !target.endsWith("/*")) throw new Error(`${d}: exports["./*"] missing or not a directory pattern`);
      return { name: pkg.name, base: resolve(d, target.slice(0, -2)) };
    })
    .sort((a, b) => b.base.length - a.base.length);
}

function inScope(rel: string): boolean {
  const p = rel.split(sep).join("/");
  if (p.includes("/node_modules/") || p.startsWith("node_modules/") || p.startsWith("docs/")) return false;
  if (/^packages\/[^/]+\/tests\/reference\//.test(p)) return false;
  return /^(packages|apps)\/[^/]+\/(src|tests)\//.test(p) || p.startsWith("tests/") || p.startsWith("scripts/");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".git") return [];
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const spaces = workspaces();
let total = 0;
let changedFiles = 0;
const errors: string[] = [];
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (!inScope(rel)) continue;
  const source = readFileSync(file, "utf8");
  const edits: { pos: number; end: number; text: string }[] = [];
  for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
    if (!ref.fileName.startsWith(".")) continue;
    // TypeScript 5.9.3 preProcessFile: `pos` is the opening quote (measured, docs/temp/pos-probe.ts); the literal
    // text follows it and must be closed by the same quote, otherwise nothing is rewritten.
    const start = ref.pos + 1;
    const quote = source[ref.pos];
    if ((quote !== '"' && quote !== "'") || source.slice(start, start + ref.fileName.length) !== ref.fileName || source[start + ref.fileName.length] !== quote) {
      errors.push(`${rel}: position mismatch for ${ref.fileName}`);
      continue;
    }
    const target = resolve(dirname(file), ref.fileName);
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${rel}: ${ref.fileName} does not resolve to a file`);
      continue;
    }
    const owner = spaces.find((w) => target.startsWith(w.base + sep));
    if (owner === undefined) {
      errors.push(`${rel}: ${ref.fileName} is outside every workspace export`);
      continue;
    }
    const text = `${owner.name}/${relative(owner.base, target).split(sep).join("/")}`;
    edits.push({ pos: start, end: start + ref.fileName.length, text });
    console.log(`${rel.split(sep).join("/")}: ${ref.fileName} -> ${text}`);
  }
  if (edits.length === 0) continue;
  let next = source;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) next = next.slice(0, e.pos) + e.text + next.slice(e.end);
  total += edits.length;
  changedFiles++;
  if (!dryRun) writeFileSync(file, next);
}
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${dryRun ? "DRY RUN " : ""}rewrote ${total} specifiers in ${changedFiles} files; ${errors.length} errors`);
process.exit(errors.length === 0 ? 0 : 1);
