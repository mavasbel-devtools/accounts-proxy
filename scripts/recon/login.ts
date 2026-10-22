/**
 * Provenance record for a profile login.
 *
 * A profile is the only place a client token may live, and refresh tokens rotate on renewal (Claude and OpenAI), so a
 * login is never exported or copied. What is recorded instead is the fact that the login happened and a hash of each
 * credential marker: enough to prove which credentials later captures were made with, without storing a secret.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LoginSignal } from "@accounts-proxy/scripts/recon/clients.ts";

/** One credential file, identified by content hash. */
export interface LoginMarker {
  /** Path relative to the sandbox home. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** `login.json` inside a profile directory. */
export interface LoginRecord {
  readonly schema: "recon-login/1";
  readonly client: string;
  readonly version: string;
  readonly at: string;
  /** True when at least one declared marker exists; `null` for a client with no marker (Antigravity). */
  readonly signedIn: boolean | null;
  readonly markers: readonly LoginMarker[];
  readonly openUrls: readonly string[];
  readonly exitCode: number;
}

/** Hash every declared marker that exists under `home`. */
export function loginMarkers(home: string, markers: readonly string[]): LoginMarker[] {
  const found: LoginMarker[] = [];
  for (const marker of markers) {
    const full = join(home, marker);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    found.push({
      path: marker,
      bytes: stat.size,
      sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
    });
  }
  return found;
}

/** Write a profile's login record (0600) and return its path. */
export function writeLoginRecord(
  profileDir: string,
  record: Omit<LoginRecord, "schema" | "markers"> & { readonly markers: readonly LoginMarker[] },
): string {
  const file = join(profileDir, "login.json");
  const payload: LoginRecord = { schema: "recon-login/1", ...record };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Read a profile's login record, or undefined when it has none. */
export function readLoginRecord(profileDir: string): LoginRecord | undefined {
  const file = join(profileDir, "login.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LoginRecord;
  } catch {
    return undefined;
  }
}

/**
 * True when a client's SQLite credential store holds at least one active credential.
 *
 * opencode 2.1.1 no longer writes `auth.json`: `auth login` creates a row in the profile's `opencode.db`
 * (`credential`, `active = 1`) and the log line `credential created ... type=oauth active=true` marks it. The probe
 * opens the database read-only and returns a count, so no credential value is read or copied.
 */
export function sqliteHasActiveCredential(file: string, integration: string): boolean {
  if (!existsSync(file)) return false;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const row = db
      .query("select count(*) as n from credential where integration_id = ? and active = 1")
      .get(integration) as { n?: number } | null;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Read a client's own statement of its authentication state from the logs it writes in the profile.
 *
 * Returns the last state the client recorded across every file matching the signal's glob, or `undefined` when the
 * client has written no state yet. Antigravity's `auth.log` is the only such log today: it records
 * `Auth state changed to: <state>` and the last line is what the client believes, so a login is proven by the client's
 * answer instead of by a file name we guessed.
 */
export function loginSignalState(home: string, signal: LoginSignal): string | undefined {
  const pattern = new RegExp(signal.statePattern, "g");
  let state: string | undefined;
  let newest = -1;
  const globs = typeof signal.glob === "string" ? [signal.glob] : signal.glob;
  for (const file of globs.flatMap((glob) => expandGlob(home, glob.split("/")))) {
    const stat = statSync(file);
    // A directory in the glob's place is not a log, and an older log cannot carry a later state.
    if (!stat.isFile() || stat.mtimeMs < newest) continue;
    const text = readLog(file);
    let match: RegExpExecArray | null;
    let last: string | undefined;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] !== undefined) last = match[1];
    }
    if (last === undefined) continue;
    newest = stat.mtimeMs;
    state = last;
  }
  return state;
}

/** Expand one glob relative to `dir`. A `*` segment matches directories only. */
function expandGlob(dir: string, segments: readonly string[]): string[] {
  const head = segments[0]!;
  const tail = segments.slice(1);
  if (head === "*") {
    return listDirectory(dir)
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => expandGlob(join(dir, entry.name), tail));
  }
  if (tail.length === 0) {
    const file = join(dir, head);
    return existsSync(file) ? [file] : [];
  }
  return expandGlob(join(dir, head), tail);
}

/** Directory entries, or none when the directory does not exist yet. */
function listDirectory(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A log's text, or empty when it cannot be read (a directory in its place, a vanished or unreadable file). */
export function readLog(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** True when every declared signal reports its signed-in state. */
export function loginSignalsSignedIn(home: string, signals: readonly LoginSignal[]): boolean {
  return signals.length > 0 && signals.every((signal) => loginSignalState(home, signal) === signal.signedInState);
}

/**
 * Correct the sign-in fields of an existing record, keeping its provenance (`at`, `version`, `openUrls`, `exitCode`).
 *
 * Used by `run <client> --verify`, which asks the client itself and the credential store what is true now; the login
 * record must not stay wrong because a marker path changed under a new client version.
 */
export function refreshLoginRecord(
  profileDir: string,
  changes: { readonly signedIn: boolean | null; readonly markers: readonly LoginMarker[] },
): string | undefined {
  const record = readLoginRecord(profileDir);
  if (record === undefined) return undefined;
  return writeLoginRecord(profileDir, { ...record, ...changes });
}
