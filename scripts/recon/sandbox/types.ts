/**
 * Sandbox description for the recon facility (plan 2026-10-19-20-04 §4).
 *
 * A spec is data only: the roles a bind plays are explicit, and building the bwrap argv from it is a pure
 * function (see bwrap.ts), so the isolation contract is unit-testable without spawning anything.
 */

/** A host path made visible inside the sandbox. */
export interface Bind {
  /** Absolute host path. */
  readonly source: string;
  /** Absolute path inside the sandbox. */
  readonly target: string;
}

/** Everything needed to launch one client inside a bubblewrap sandbox. */
export interface SandboxSpec {
  /** Persistent profile home, mounted at {@link HOME_IN_SANDBOX}. */
  readonly profileHome: string;
  /** UTS hostname of the sandbox, stable per profile, so no client can report the operator's host name. */
  readonly hostname: string;
  /** Working directory, bound read-write at the same absolute path. */
  readonly workdir: string;
  /** Trees bound read-only at their own paths (for example /usr, /lib, /etc). */
  readonly systemBinds: readonly string[];
  /** Client install trees bound read-only (claude versions, the IDE bundle, ...). */
  readonly readonlyBinds: readonly Bind[];
  /** Per-run writable trees beyond profileHome and workdir. */
  readonly writableBinds: readonly Bind[];
  /** Directories replaced by an empty tmpfs inside the sandbox. */
  readonly tmpfs: readonly string[];
  /** Environment variables set for the client. */
  readonly env: Readonly<Record<string, string>>;
  /** Executable and arguments, relative to the sandbox filesystem. */
  readonly command: readonly string[];
}

/** The profile is always mounted here, never at the host's real home path. */
export const HOME_IN_SANDBOX = "/home/recon";

/** The per-run working directory, bound from the run scratch dir. */
export const WORK_IN_SANDBOX = "/work";

/** Client install trees are mounted under this prefix, so the host home path never appears in the sandbox. */
export const INSTALL_ROOT = "/clients";

/** CA bundle path inside the sandbox (root is the sandbox's own tmpfs, so the file can be created there). */
export const CA_IN_SANDBOX = "/recon-ca.pem";

/** First `PATH` entry: the sandbox's own tools (`xdg-open`), never a host directory. */
export const OPEN_BIN_DIR_IN_SANDBOX = "/recon-bin";
/** Private session bus + keyring launcher inside the sandbox. */
export const SESSION_BIN = "/recon-bin/session";

/** Host directory holding the private X server's unix sockets, mounted rw for GUI clients only. */
export const X11_SOCKET_DIR = "/tmp/.X11-unix";
