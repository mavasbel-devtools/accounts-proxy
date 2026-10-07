// Export files from a git commit with their exact bytes (no shell redirection, no newline translation).
// Usage: bun scripts/evidence/export-files.ts <repo> <commit> <out-dir> <repo-relative-path>...
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [repo, commit, out, ...paths] = process.argv.slice(2);
if (!repo || !commit || !out || paths.length === 0) {
  console.error("usage: export-files.ts <repo> <commit> <out-dir> <repo-relative-path>...");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
for (const path of paths) {
  const bytes = execFileSync("git", ["-C", repo, "show", `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  const blob = execFileSync("git", ["-C", repo, "rev-parse", `${commit}:${path}`], { encoding: "utf8" }).trim();
  writeFileSync(join(out, basename(path)), bytes);
  console.log(`${blob} ${bytes.length} ${path}`);
}
