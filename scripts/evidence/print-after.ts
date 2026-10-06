// P0 helper: print <length> characters of a text file starting at the first occurrence of <marker>,
// wrapped at 300 columns so long minified lines stay readable.
// Usage: bun scripts/evidence/print-after.ts <file> <marker> <length>
import { readFileSync } from "node:fs";

const [file, marker, lengthArg] = process.argv.slice(2);
if (!file || !marker || !lengthArg) {
  console.error("usage: print-after.ts <file> <marker> <length>");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const at = text.indexOf(marker);
if (at < 0) {
  console.error(`marker not found: ${marker}`);
  process.exit(1);
}
console.log(text.slice(at, at + Number(lengthArg)).match(/.{1,300}/g)?.join("\n") ?? "");
