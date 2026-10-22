/**
 * Isolation guard: a metadata fingerprint of the REAL client directories taken before and after a sandboxed run.
 *
 * The sandbox is expected to make these paths unreachable, so any fingerprint change is a failure of the isolation
 * contract and the run is reported as such. Metadata only (path, size, mtime) keeps a multi-gigabyte store cheap to
 * check; a change of content always moves the mtime or size of the file that changed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/** Fingerprint of one guarded path. */
export interface PathFingerprint {
  readonly path: string;
  readonly exists: boolean;
  readonly hash: string;
  readonly entries: number;
}

/** One path's fingerprint. Directories are walked without crossing filesystems. */
export function fingerprintPath(path: string): PathFingerprint {
  if (!existsSync(path)) {
    return { path, exists: false, hash: "absent", entries: 0 };
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    const digest = createHash("sha256");
    digest.update(readFileSync(path));
    const hash = createHash("sha256").update(`${stat.size}:${stat.mtimeMs}:${digest.digest("hex")}`).digest("hex");
    return { path, exists: true, hash, entries: 1 };
  }
  const result = spawnSync("find", [path, "-xdev", "-printf", "%P\\0%s\\0%T@\\0"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`find failed for ${path}: ${result.stderr.toString("utf8").trim()}`);
  }
  const manifest = result.stdout;
  // Directory traversal order is not stable across calls; sort the (path, size, mtime) records before hashing.
  const fields = manifest.length === 0 ? [] : manifest.toString("latin1").split("\0");
  const records: string[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    records.push(`${fields[index]}\0${fields[index + 1]}\0${fields[index + 2]}`);
  }
  records.sort();
  return {
    path,
    exists: true,
    hash: createHash("sha256").update(records.join("\n")).digest("hex"),
    entries: records.length,
  };
}

/** Fingerprint every path, keyed by path. Missing paths are recorded as absent. */
export function snapshotPaths(paths: readonly string[]): Record<string, PathFingerprint> {
  const snapshot: Record<string, PathFingerprint> = {};
  for (const path of paths) {
    snapshot[path] = fingerprintPath(path);
  }
  return snapshot;
}

/** Paths whose fingerprint differs between two snapshots, including ones that appeared or vanished. */
export function changedPaths(
  before: Readonly<Record<string, PathFingerprint>>,
  after: Readonly<Record<string, PathFingerprint>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    const a = before[key];
    const b = after[key];
    if (!a || !b || a.hash !== b.hash || a.exists !== b.exists || a.entries !== b.entries) {
      changed.push(key);
    }
  }
  return changed;
}
