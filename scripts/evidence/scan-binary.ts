// P0-E6 helper: print bounded context windows around literal patterns inside a binary
// (e.g. the official Claude Code executable, a Bun single-file build that embeds its JS source).
// Usage: bun scripts/evidence/scan-binary.ts <file> <window> <maxHitsPerPattern> <pattern>...
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const [file, windowArg, maxArg, ...patterns] = process.argv.slice(2);
if (!file || !windowArg || !maxArg || patterns.length === 0) {
  console.error("usage: scan-binary.ts <file> <window> <maxHits> <pattern>...");
  process.exit(2);
}
const bytes = readFileSync(file);
// Search the raw bytes (Buffer#indexOf), never a 200+ MB decoded string: a latin1-decoded copy of the
// 237 MB Claude Code executable measurably missed occurrences that Buffer#indexOf finds.
const slice = (start: number, end: number): string => bytes.subarray(start, end).toString("latin1");
console.log(`file=${file} bytes=${statSync(file).size} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
const window = Number(windowArg);
const max = Number(maxArg);
for (const pattern of patterns) {
  let from = 0;
  let hits = 0;
  let total = 0;
  const seen = new Set<string>();
  for (;;) {
    const at = bytes.indexOf(Buffer.from(pattern, "latin1"), from);
    if (at < 0) break;
    total++;
    from = at + pattern.length;
    const snippet = slice(Math.max(0, at - window), at + pattern.length + window).replace(/[^\x20-\x7e]/g, ".");
    if (seen.has(snippet) || hits >= max) continue;
    seen.add(snippet);
    hits++;
    console.log(`--- [${pattern}] @${at}\n${snippet}`);
  }
  console.log(`=== [${pattern}] total occurrences: ${total}`);
}
