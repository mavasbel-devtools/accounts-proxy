/**
 * Merge one key into a VS Code-style JSON settings file.
 *
 * `settings.json` in a VS Code fork is JSON with comments in practice. A profile created by the recon facility starts
 * empty, so the common case is a new file; an existing file is merged only when it parses as JSON, because silently
 * rewriting a file that carries the operator's comments or a trailing comma would be worse than leaving it alone.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Set `key` in `file`, preserving other keys. Returns false when the file exists and cannot be parsed. */
export function mergeJsonSetting(file: string, key: string, value: unknown): boolean {
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      current = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  current[key] = value;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}
