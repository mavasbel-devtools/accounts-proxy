// Proof that the alias codemod is purely mechanical (alias-imports plan, step 4).
// Input: the codemod's run log (one `<file>: <relative> -> <alias>` line per rewrite). For every file in the log,
// compared with <base>: same line count; every rewrite in the log appears on a differing line, in order, as
// `<relative>` → `<alias>`; with the specifier literals blanked out the old and new lines are identical; and no
// other line differs — except the lines passed as `--allow <file>:<line>` (deliberate, separately reviewed edits).
// Usage: bun scripts/evidence/verify-alias-diff.ts <base-commit> <codemod-log> [--allow <file>:<line>]...
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [base, log, ...rest] = process.argv.slice(2);
if (!base || !log) {
  console.error("usage: verify-alias-diff.ts <base-commit> <codemod-log> [--allow <file>:<line>]...");
  process.exit(2);
}
const allowed = new Set(rest.filter((_, i) => rest[i - 1] === "--allow"));
const root = resolve(import.meta.dir, "..", "..");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const expected = new Map<string, [string, string][]>();
for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
  const m = /^(.+?): (\.\.?\/\S+) -> (@inference-router\/\S+)$/.exec(line);
  if (m) expected.set(m[1]!, [...(expected.get(m[1]!) ?? []), [m[2]!, m[3]!]]);
}
const SPEC = /(["'])((?:\.{1,2}\/|@inference-router\/)[^"']*)\1/g;
const failures: string[] = [];
const exceptions: string[] = [];
let verified = 0;
let logged = 0;
for (const [file, rewrites] of expected) {
  logged += rewrites.length;
  const a = git("show", `${base}:${file}`).split("\n");
  const b = readFileSync(join(root, file), "utf8").split("\n");
  if (a.length !== b.length) {
    failures.push(`${file}: line count ${a.length} -> ${b.length}`);
    continue;
  }
  const seen: [string, string][] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const where = `${file}:${i + 1}`;
    const oldSpecs = [...a[i]!.matchAll(SPEC)].map((m) => m[2]!);
    const newSpecs = [...b[i]!.matchAll(SPEC)].map((m) => m[2]!);
    const sameShape = oldSpecs.length === newSpecs.length && a[i]!.replace(SPEC, '""') === b[i]!.replace(SPEC, '""');
    if (!sameShape) {
      if (allowed.has(where)) exceptions.push(where);
      else failures.push(`${where}: changes outside an import specifier`);
      continue;
    }
    for (let k = 0; k < oldSpecs.length; k++) if (oldSpecs[k] !== newSpecs[k]) seen.push([oldSpecs[k]!, newSpecs[k]!]);
  }
  if (JSON.stringify(seen) !== JSON.stringify(rewrites)) failures.push(`${file}: rewrites on disk differ from the codemod log`);
  else verified += seen.length;
}
for (const f of failures) console.error(`FAIL ${f}`);
for (const e of exceptions) console.log(`ALLOWED non-import change ${e}`);
const unused = [...allowed].filter((a) => !exceptions.includes(a));
for (const u of unused) console.error(`FAIL --allow ${u} matched no change`);
console.log(`${expected.size} files; ${verified}/${logged} logged rewrites verified; ${exceptions.length} allowed exceptions; ${failures.length + unused.length} failures`);
process.exit(failures.length + unused.length === 0 ? 0 : 1);
