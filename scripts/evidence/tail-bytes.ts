// P0 helper: print a file's size and its last <n> bytes (decimal and JSON-escaped text), to establish
// exactly how a captured stream terminates. Usage: bun scripts/evidence/tail-bytes.ts <file> <n>
import { readFileSync } from "node:fs";

const [file, countArg] = process.argv.slice(2);
if (!file || !countArg) {
  console.error("usage: tail-bytes.ts <file> <n>");
  process.exit(2);
}
const bytes = readFileSync(file);
const tail = bytes.subarray(Math.max(0, bytes.length - Number(countArg)));
console.log(`bytes=${bytes.length}`);
console.log(`tail=${[...tail].join(",")}`);
console.log(`text=${JSON.stringify(tail.toString("utf8"))}`);
