/**
 * Per-client persistent profiles for the recon facility.
 *
 * A profile is the ONLY home a sandboxed client can see. It survives between runs so an interactive login is done
 * once per client and then reused, and it lives outside the repository (0600/0700) because it holds client tokens.
 *
 * A profile also carries the sandbox's own identity: a dedicated `/etc/machine-id` value. Two clients never share it,
 * and neither of them can observe the host's machine id, so state that a client keys by machine id (caches, device
 * registration) cannot collide with the operator's real installation.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { HOME_IN_SANDBOX } from "@accounts-proxy/scripts/recon/sandbox/types.ts";

/** Directory layout of one client profile. */
export interface Profile {
  /** Client id (claude, opencode, codex, antigravity). */
  readonly client: string;
  /** `<root>/profiles/<client>` */
  readonly dir: string;
  /** Persistent sandbox home. */
  readonly home: string;
  /** Scratch directory shared with the sandbox as TMPDIR. */
  readonly tmp: string;
  /** Per-client working directory template (each run binds a run-scoped copy). */
  readonly work: string;
}

/** Root of all recon state: captures, profiles, run scratch. Never inside the repository. */
export function reconRoot(): string {
  const explicit = process.env.ACCOUNTS_PROXY_RECON_ROOT;
  if (explicit && explicit.trim() !== "") {
    return resolve(explicit);
  }
  const dataHome = process.env.ACCOUNTS_PROXY_HOME ?? join(homedir(), ".local", "share", "accounts-proxy");
  return join(resolve(dataHome), "recon");
}

/** Layout for one client id. */
export function profileFor(client: string): Profile {
  const dir = join(reconRoot(), "profiles", client);
  return { client, dir, home: join(dir, "home"), tmp: join(dir, "tmp"), work: join(dir, "work") };
}

/** The machine id file a profile binds over `/etc/machine-id`. */
export function machineIdPath(profile: Profile): string {
  return join(profile.dir, "machine-id");
}

/** Files that carry the sandbox's own identity, each bound over its host counterpart. */
export interface IdentityFiles {
  readonly machineId: string;
  readonly hostname: string;
  readonly passwd: string;
  readonly group: string;
}

/** Paths of the per-profile identity files. */
export function identityFiles(profile: Profile): IdentityFiles {
  return {
    machineId: machineIdPath(profile),
    hostname: join(profile.dir, "hostname"),
    passwd: join(profile.dir, "passwd"),
    group: join(profile.dir, "group"),
  };
}

/** Create every directory a sandboxed run needs, owner-only, plus a stable machine id. `clientDirs` are relative to the sandbox home. */
export function ensureProfile(profile: Profile, clientDirs: readonly string[] = []): void {
  const dirs = [
    profile.dir,
    profile.home,
    profile.tmp,
    profile.work,
    join(profile.home, ".config"),
    join(profile.home, ".local", "share"),
    join(profile.home, ".local", "state"),
    join(profile.home, ".cache"),
    join(profile.home, ".run"),
    ...clientDirs.map((dir) => join(profile.home, dir)),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const identity = identityFiles(profile);
  if (!existsSync(identity.machineId)) {
    writeFileSync(identity.machineId, `${randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(identity.machineId, 0o600);
  // The sandbox keeps the caller's numeric uid/gid (files stay owned by the operator) but every name resolves to
  // `recon`, so a client cannot report the operator's account name.
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  writeFileSync(
    identity.passwd,
    [
      `root:x:0:0:root:/root:/bin/sh`,
      `recon:x:${uid}:${gid}:Recon Operator:${HOME_IN_SANDBOX}:/bin/sh`,
      `nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin`,
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  writeFileSync(
    identity.group,
    [`root:x:0:`, `recon:x:${gid}:`, `nogroup:x:65534:`, ""].join("\n"),
    { mode: 0o644 },
  );
  writeFileSync(identity.hostname, `${hostnameOf(profile)}\n`, { mode: 0o644 });
  // The passphrase that unlocks the profile's own keyring. It protects nothing from the operator (the keyring sits in
  // the same profile) but it makes the keyring self-contained and per-profile, so two clients never share one store.
  const passphrase = keyringPassphrasePath(profile);
  if (!existsSync(passphrase)) {
    writeFileSync(passphrase, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(passphrase, 0o600);
}

/** Path of the per-profile keyring passphrase. */
export function keyringPassphrasePath(profile: Profile): string {
  return join(profile.dir, "keyring.passphrase");
}

/**
 * Take the profile's run lock and return its path.
 *
 * Two runs on one profile do not isolate anything: the second client finds the first one's single-instance state and
 * exits immediately (measured: a 5-minute Antigravity run recorded nothing because an earlier run's IDE was still up).
 * A stale lock from a crashed run is reclaimed by checking the recorded pid.
 */
export function acquireProfileLock(profile: Profile): string {
  const file = join(profile.dir, "run.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new Error(`${profile.client}: another recon run holds the profile (pid ${holder}); wait for it to finish`);
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error(`${profile.client}: could not take the profile lock`);
}

/** Release the lock returned by {@link acquireProfileLock}. */
export function releaseProfileLock(file: string): void {
  rmSync(file, { force: true });
}

/** True when `pid` names a live process this user may signal. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The passphrase that unlocks a profile's keyring, generated with the profile. */
export function keyringPassphrase(profile: Profile): string {
  return readFileSync(keyringPassphrasePath(profile), "utf8").trim();
}

/**
 * Refuse to run when the profile is not a dedicated directory: it must live under the recon root and must not be the
 * user's real home or contain it.
 */
export function assertIsolatedProfile(profile: Profile): void {
  const root = reconRoot();
  const home = resolve(profile.home);
  const realHome = resolve(homedir());
  if (home === realHome || realHome.startsWith(home + sep)) {
    throw new Error(`refusing to use ${home}: it is or contains the real home`);
  }
  if (!home.startsWith(resolve(root) + sep)) {
    throw new Error(`refusing to use ${home}: not under ${root}`);
  }
  if (statSync(profile.dir).mode & 0o077) {
    throw new Error(`refusing to use ${profile.dir}: mode is not 0700`);
  }
}

/** Remove one profile and everything a login stored in it. Guarded by the same isolation rules. */
export function resetProfile(profile: Profile): void {
  if (!existsSync(profile.dir)) return;
  assertIsolatedProfile(profile);
  rmSync(profile.dir, { recursive: true, force: true });
}

/** Real path of an existing directory, or a thrown error naming it. */
export function requireDirectory(path: string): string {
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new Error(`${path} is not a directory`);
  }
  return real;
}

/** Stable machine id value of a profile (without the trailing newline). */
export function machineIdOf(profile: Profile): string {
  return readFileSync(machineIdPath(profile), "utf8").trim();
}

/** UTS hostname of a profile, derived from its machine id: stable, unique per profile, never the operator's. */
export function hostnameOf(profile: Profile): string {
  return `sandbox-${machineIdOf(profile).slice(0, 12)}`;
}
