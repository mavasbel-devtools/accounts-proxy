// Guarded temporary directories for tests (project law, incident 2026-09-26: an unguarded rm("") deleted a
// working tree because on Windows an empty path resolves to the locked cwd). Every recursive delete in this
// repository goes through removeTemporary, which refuses anything that is not strictly inside os.tmpdir().
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function temporaryRoot(): string {
  return realpathSync(tmpdir());
}

export function makeTemporary(prefix: string): string {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error(`invalid temporary prefix: ${JSON.stringify(prefix)}`);
  return realpathSync(mkdtempSync(join(temporaryRoot(), `inference-router-${prefix}-`)));
}

export function isStrictlyInsideTemporary(path: string): boolean {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) return false;
  const rel = relative(temporaryRoot(), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

export function removeTemporary(path: string | undefined): void {
  if (path === undefined || !isStrictlyInsideTemporary(path)) {
    throw new Error(`refusing to delete a path outside ${temporaryRoot()}: ${JSON.stringify(path)}`);
  }
  rmSync(path, { recursive: true, force: true });
}
