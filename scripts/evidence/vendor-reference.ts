// Export pinned source files of a plugin repository as a test-only parity reference.
// Each file is `git show <commit>:src/<path>`; the ONLY edit is rewriting the alias prefix
// (e.g. '@antigravity/') to a relative path, so the copy resolves inside the reference tree.
// Writes <out>/MANIFEST.json with the source blob id of every file.
// Usage: bun scripts/evidence/vendor-reference.ts <repo> <commit> <alias> <out> <src-relative-path>...
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const [repo, commit, alias, out, ...files] = process.argv.slice(2);
if (!repo || !commit || !alias || !out || files.length === 0) {
  console.error("usage: vendor-reference.ts <repo> <commit> <alias> <out> <src-relative-path>...");
  process.exit(2);
}
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const manifest: { file: string; blob: string; aliasRewrites: number }[] = [];
for (const file of files) {
  const source = git("show", `${commit}:src/${file}`);
  const blob = git("rev-parse", `${commit}:src/${file}`).trim();
  const up = posix.relative(posix.dirname(file), ".") || ".";
  const prefix = up.startsWith(".") ? `${up}/` : `./${up}/`;
  let rewrites = 0;
  const rewritten = source.replace(new RegExp(`(['"])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), (_m, quote: string) => {
    rewrites++;
    return `${quote}${prefix}`;
  });
  const target = join(out, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewritten);
  manifest.push({ file, blob, aliasRewrites: rewrites });
}
writeFileSync(join(out, "MANIFEST.json"), JSON.stringify({ repo: "opencode plugin", commit, alias, files: manifest }, null, 2) + "\n");
console.log(manifest.map((m) => `${m.blob.slice(0, 8)} ${m.file} (${m.aliasRewrites} rewrites)`).join("\n"));
