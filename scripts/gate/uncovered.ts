// Development aid: list every uncovered branch / statement / function in a coverage-final.json with its source text.
// Usage: bun scripts/gate/uncovered.ts <coverage-final.json> [path-substring]
import { readFileSync } from "node:fs";

type Loc = { start: { line: number; column: number }; end: { line: number; column: number | null } };
type FileCoverage = {
  path: string;
  statementMap: Record<string, Loc>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; loc: Loc }>;
  f: Record<string, number>;
  branchMap: Record<string, { type: string; loc: Loc; locations: Loc[] }>;
  b: Record<string, number[]>;
};

const [file, filter = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: uncovered.ts <coverage-final.json> [path-substring]");
  process.exit(2);
}
const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, FileCoverage>;
for (const cov of Object.values(data)) {
  if (!cov.path.replaceAll("\\", "/").includes(filter)) continue;
  const lines = readFileSync(cov.path, "utf8").split(/\r?\n/);
  const at = (loc: Loc) => `${loc.start.line}:${loc.start.column}  ${(lines[loc.start.line - 1] ?? "").trim().slice(0, 140)}`;
  const out: string[] = [];
  for (const [id, hits] of Object.entries(cov.s)) if (hits === 0) out.push(`  statement ${at(cov.statementMap[id]!)}`);
  for (const [id, hits] of Object.entries(cov.f)) if (hits === 0) out.push(`  function ${cov.fnMap[id]!.name} ${at(cov.fnMap[id]!.loc)}`);
  for (const [id, hits] of Object.entries(cov.b)) {
    const branch = cov.branchMap[id]!;
    hits.forEach((h, i) => {
      const loc = branch.locations[i];
      if (h === 0) out.push(`  branch ${branch.type}[${i}] ${at(loc?.start.line === undefined ? branch.loc : loc)}`);
    });
  }
  if (out.length > 0) console.log(`${cov.path}\n${out.join("\n")}`);
}
