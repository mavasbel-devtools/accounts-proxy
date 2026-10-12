// Export pinned source files of a plugin repository as a test-only parity reference, BYTE-IDENTICAL to the source.
// Each file is `git show <commit>:src/<path>` written to <out>/<path> unchanged; the plugin's own import alias
// (e.g. `@antigravity/` → its src/) is resolved by a tsconfig.json written to <out> ({ paths: { "<alias>*": ["./*"] } }),
// which Bun honours for files under <out> (measured 2026-10-07, alias-imports plan §2). Every written file is
// verified with `git hash-object --no-filters` against its source blob. <out>/MANIFEST.json records the blobs.
// Usage: bun scripts/evidence/vendor-reference.ts [--prefix=<dir/>] <repo> <commit> <alias> <out> <src-relative-path>...
// `--prefix` is the source directory inside the repository (default `src/`; e.g. `packages/core/src/` for opencode).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const prefixArg = args.find((a) => a.startsWith("--prefix="));
const prefix = prefixArg === undefined ? "src/" : prefixArg.slice("--prefix=".length);
const [repo, commit, alias, out, ...files] = args.filter((a) => a !== prefixArg);
if (!repo || !commit || !alias || !out || files.length === 0) {
  console.error("usage: vendor-reference.ts <repo> <commit> <alias> <out> <src-relative-path>...");
  process.exit(2);
}
const repository = resolve(import.meta.dir, "..", "..");
const target = resolve(out);
if (!target.startsWith(join(repository, "packages")) || !/[\\/]tests[\\/]reference[\\/]plugin-[0-9a-f]+$/.test(target)) {
  console.error(`refusing to write outside packages/*/tests/reference/plugin-<sha>: ${target}`);
  process.exit(2);
}
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
rmSync(target, { recursive: true, force: true });
const manifest: { file: string; blob: string; bytes: number }[] = [];
let mismatches = 0;
for (const file of files) {
  const bytes = git("show", `${commit}:${prefix}${file}`);
  const blob = git("rev-parse", `${commit}:${prefix}${file}`).toString("utf8").trim();
  const path = join(target, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const written = execFileSync("git", ["hash-object", "--no-filters", path], { encoding: "utf8" }).trim();
  if (written !== blob) {
    mismatches++;
    console.error(`MISMATCH ${file}: written ${written} != source ${blob}`);
  }
  manifest.push({ file, blob, bytes: bytes.length });
}
writeFileSync(join(target, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { paths: { [`${alias}*`]: ["./*"] } } }, null, 2)}\n`);
writeFileSync(join(target, "MANIFEST.json"), `${JSON.stringify({ commit, alias, prefix, byteIdentical: true, files: manifest }, null, 2)}\n`);
console.log(manifest.map((m) => `${m.blob.slice(0, 8)} ${m.bytes} ${m.file}`).join("\n"));
console.log(`${manifest.length} files, ${mismatches} blob mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
