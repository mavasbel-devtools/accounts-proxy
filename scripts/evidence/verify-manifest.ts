// Verify that every file listed in docs/reference/specs/manifest.json still has its recorded SHA-256 and size.
// Usage: bun scripts/evidence/verify-manifest.ts [file-root]   (default: docs/reference/specs)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dir, "..", "..", "docs", "reference", "specs"));
const manifest = JSON.parse(readFileSync(join(resolve(join(import.meta.dir, "..", "..", "docs", "reference", "specs")), "manifest.json"), "utf8")) as {
  file: string;
  bytes: number;
  sha256: string;
}[];
let failures = 0;
for (const entry of Array.isArray(manifest) ? manifest : Object.values(manifest)) {
  const path = join(root, entry.file);
  if (!existsSync(path)) {
    console.log(`MISSING  ${entry.file}`);
    failures++;
    continue;
  }
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ok = sha === entry.sha256 && bytes.length === entry.bytes;
  if (!ok) failures++;
  console.log(`${ok ? "OK      " : "MISMATCH"} ${entry.file} bytes=${bytes.length}/${entry.bytes}`);
}
process.exit(failures === 0 ? 0 : 1);
