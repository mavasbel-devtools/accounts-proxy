// Risk R1 evidence (P4 plan §4): per source file, what the e2e tier alone leaves uncovered, from the e2e gate's
// coverage-final.json, plus the files the e2e daemons never loaded. Prints a markdown table.
// Usage: bun scripts/evidence/e2e-gaps.ts [coverage/e2e/coverage-final.json]
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";

type FileCoverage = { path: string; s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]> };

const file = process.argv[2] ?? join(repositoryRoot, "coverage", "e2e", "coverage-final.json");
const unit = JSON.parse(readFileSync(join(repositoryRoot, "coverage", "unit", "coverage-final.json"), "utf8")) as Record<string, FileCoverage>;
const e2e = JSON.parse(readFileSync(file, "utf8")) as Record<string, FileCoverage>;

const count = (values: number[]) => [values.filter((v) => v === 0).length, values.length] as const;
const rows: string[] = [];
let totals = { s: 0, b: 0, f: 0 };
for (const path of Object.keys(unit).sort()) {
  const rel = relative(repositoryRoot, path);
  const cov = e2e[path];
  if (cov === undefined) {
    rows.push(`| \`${rel}\` | never loaded | | |`);
    continue;
  }
  const [s, st] = count(Object.values(cov.s));
  const [b, bt] = count(Object.values(cov.b).flat());
  const [f, ft] = count(Object.values(cov.f));
  if (s + b + f === 0) continue;
  totals = { s: totals.s + s, b: totals.b + b, f: totals.f + f };
  rows.push(`| \`${rel}\` | ${s}/${st} | ${b}/${bt} | ${f}/${ft} |`);
}
console.log(`| File | Uncovered statements | Uncovered branches | Uncovered functions |\n|---|---|---|---|\n${rows.join("\n")}\n| **total (loaded files)** | **${totals.s}** | **${totals.b}** | **${totals.f}** |`);
