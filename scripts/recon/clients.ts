/**
 * The four reference clients of the recon facility (plan 2026-10-19-20-04 §4).
 *
 * Each definition states: where the binary is, which install trees must be visible read-only (mounted under
 * `/clients`, never at their host paths), which real directories must stay untouched (the guard), the environment
 * that redirects all client state into the sandbox profile, and which files prove the profile is signed in.
 *
 * Every path and variable here is evidence-backed: state directories were observed on this machine, and environment
 * names were read from the installed binaries (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, ...).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { sqliteHasActiveCredential } from "@accounts-proxy/scripts/recon/login.ts";
import {
  HOME_IN_SANDBOX,
  INSTALL_ROOT,
  type Bind,
} from "@accounts-proxy/scripts/recon/sandbox/types.ts";

/** A log in which a client states its own authentication state. */
export interface LoginSignal {
  /**
   * Glob, relative to the sandbox home, of the log; several when the client writes it in more than one place. A `*`
   * matches one path segment. The newest log across every glob decides.
   */
  readonly glob: string | readonly string[];
  /** Regex whose capture group 1 is the state. Every match is read; the last one is the current state. */
  readonly statePattern: string;
  /** The state value that means the profile is signed in. */
  readonly signedInState: string;
}

/** Static description of one client. */
export interface ReconClient {
  readonly id: string;
  readonly label: string;
  readonly cell: string;
  /** True when the client needs an X display. */
  readonly gui: boolean;
  /** Window name used to find the client on the private display and to close it gracefully. */
  readonly windowName?: string;
  /** Host binary and the same binary inside the sandbox. */
  readonly binary: Bind;
  readonly versionArgs: readonly string[];
  /** Read the version from a JSON manifest instead of running the binary (GUI apps that ignore --version). */
  readonly versionManifest?: { readonly path: string; readonly key: string };
  readonly readonlyBinds: readonly Bind[];
  /** Real directories that the guard fingerprints before and after every run. */
  readonly guards: readonly string[];
  /**
   * Host directories that belong to the operator's identity rather than to a client: a login keyring, the browser
   * NSS database, a cloud SDK. Any client can reach them by default, so they are guarded as well.
   */
  readonly identityGuards: readonly string[];
  /** Client-specific environment, merged over the shared isolated environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Directories (relative to the sandbox home) the client requires to exist. */
  readonly profileDirs: readonly string[];
  /** Files (relative to the sandbox home) whose presence proves the profile holds a login. */
  readonly authMarkers: readonly string[];
  /**
   * Reads the profile directly when a file marker cannot answer.
   *
   * opencode 2.1.1 keeps OAuth credentials in `opencode.db` (`credential`, `active = 1`), so the presence of a file
   * proves nothing and the absence of `auth.json` proves nothing either. The probe returns true only when an active
   * credential exists for the client's own integration.
   */
  readonly signedIn?: (home: string) => boolean;
  /**
   * Logs in which the client states its own authentication state, for a client with no credential marker.
   *
   * Antigravity keeps Google credentials in Electron safe storage, so no file name proves a login. Its `auth.log`
   * records `Auth state changed to: <state>`; the last state the client wrote is the client's own answer, which is
   * stronger evidence than a file we guessed the name of.
   */
  readonly loginSignals?: readonly LoginSignal[];
  /**
   * True when the client keeps credentials in the OS keyring, so it needs a private session bus and keyring inside the
   * sandbox. Without one it stores the token in memory and the login dies with the process (measured on Antigravity).
   */
  readonly session?: boolean;
  /** Default argv when the caller passes none. */
  readonly defaultCommand: readonly string[];
  /**
   * Interactive login argv, run once per profile.
   *
   * A `@TARGET@` entry is replaced by the value of `--target` and dropped when no target is given, so a client whose
   * login flow can start straight at one integration still works interactively.
   */
  readonly loginCommand: readonly string[];
  /** Integration ids the client's own login flow accepts, when it documents them. */
  readonly loginTargets?: readonly string[];
  /** Command that reports signed-in state from inside the sandbox. */
  readonly authStatusCommand?: readonly string[];
  /**
   * GUI only: clicks that drive the client from launch to a printed login URL.
   *
   * A GUI client's sign-in button is invisible on the private X server, so the operator cannot click it. Each entry is
   * a window-relative click, executed in order after the launch delay. The coordinates are part of the version pin:
   * they are verified against the client version named in the capability matrix and must be re-measured on upgrade.
   */
  readonly loginClicks?: readonly { readonly x: number; readonly y: number; readonly afterMs?: number }[];
  /**
   * The sign-in path as button labels, clicked through the client's own DOM in order. Preferred over `loginClicks`: a
   * label survives a layout change, a coordinate does not, and the button that proves this on Antigravity 1.107.0 is
   * "Continue with Google", which the trust and migration dialogs cover until they are answered.
   */
  readonly loginButtons?: readonly string[];
  /**
   * Regex of the request URL that carries one model turn. A run that was asked to send prompts and recorded none failed,
   * whatever its exit code: measured on Antigravity, a login run whose prompts never reached the chat panel exited 0.
   */
  readonly turnRequest?: string;
  /** Hard stop for the default command; GUI clients are killed, never left running. */
  readonly timeoutMs: number;
  /**
   * Regex of upstream SNI values to intercept. Empty means every host. A GUI client sets it so its Chromium login UI
   * and telemetry pass through untampered while the language server's API hosts are still captured.
   */
  readonly interceptHosts?: string;
  /**
   * Substring of `/proc/<pid>/cmdline` that identifies the operator's own running instance of this client. Used only
   * to attribute a guarded-path change to the live session instead of to our sandbox; it is never a leak excuse,
   * because the in-sandbox probe is the authoritative check.
   */
  readonly processMarker: string;
}

/** Resolve an executable name to its real path, failing loudly when it is not installed. */
export function resolveBinary(name: string): string {
  const found = execFileSync("which", [name], { encoding: "utf8" }).trim();
  if (found === "") {
    throw new Error(`${name} is not installed`);
  }
  return realpathSync(found);
}

/** Antigravity ships as an unpacked Electron app; allow an explicit override for other machines. */
function antigravityRoot(): string {
  const override = process.env.ACCOUNTS_PROXY_RECON_ANTIGRAVITY_HOME;
  const root = override && override.trim() !== "" ? override : join(homedir(), "Downloads", "Antigravity IDE");
  if (!existsSync(root)) {
    throw new Error(`Antigravity IDE not found at ${root} (set ACCOUNTS_PROXY_RECON_ANTIGRAVITY_HOME)`);
  }
  return realpathSync(root);
}

const home = homedir();

/** Directories every login-capable desktop stack may write; guarded for every client. */
function identityGuards(): string[] {
  return [
    join(home, ".local", "share", "keyrings"),
    join(home, ".config", "keyrings"),
    join(home, ".pki", "nssdb"),
  ];
}

/** Claude Code: Anthropic Messages, subscription OAuth. */
function claude(): ReconClient {
  const binary = resolveBinary("claude");
  const install = join(home, ".local", "share", "claude");
  const target = `${INSTALL_ROOT}/claude/versions/${basename(binary)}`;
  return {
    id: "claude",
    label: "Claude Code",
    cell: "claude",
    gui: false,
    binary: { source: binary, target },
    versionArgs: ["--version"],
    readonlyBinds: [{ source: install, target: `${INSTALL_ROOT}/claude` }],
    guards: [
      join(home, ".claude"),
      join(home, ".claude.json"),
      join(home, ".claude.json.backup"),
      join(home, ".cache", "claude"),
      join(home, ".local", "state", "claude"),
    ],
    identityGuards: identityGuards(),
    env: { CLAUDE_CONFIG_DIR: `${HOME_IN_SANDBOX}/.claude` },
    profileDirs: [".claude"],
    authMarkers: [".claude/.credentials.json"],
    processMarker: "/claude/versions/",
    defaultCommand: [target, "-p", "Reply with the single word: ok", "--model", "sonnet"],
    loginCommand: [target, "auth", "login", "--claudeai"],
    authStatusCommand: [target, "auth", "status"],
    timeoutMs: 120_000,
  };
}

/** opencode: all four dialects plus its own Console and Go cells. */
function opencode(): ReconClient {
  const binary = resolveBinary("opencode");
  const install = join(home, ".opencode", "bin");
  const target = `${INSTALL_ROOT}/opencode/${basename(binary)}`;
  return {
    id: "opencode",
    label: "opencode",
    cell: "opencode",
    gui: false,
    binary: { source: binary, target },
    versionArgs: ["--version"],
    readonlyBinds: [{ source: install, target: `${INSTALL_ROOT}/opencode` }],
    guards: [
      join(home, ".config", "opencode"),
      join(home, ".local", "share", "opencode"),
      join(home, ".local", "state", "opencode"),
      join(home, ".cache", "opencode"),
      // The install tree lives here; guarded because a run must not touch it, bound read-only above.
      join(home, ".opencode"),
    ],
    identityGuards: identityGuards(),
    env: {
      OPENCODE_CONFIG_DIR: `${HOME_IN_SANDBOX}/.config/opencode`,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    profileDirs: [".config/opencode", ".local/share/opencode", ".local/state/opencode", ".cache/opencode"],
    authMarkers: [],
    // 2.1.1 stores the credential in the profile database, not in auth.json; the SQLite probe is the only honest
    // answer, and `opencode auth list` inside the sandbox confirms it independently.
    signedIn: (profileHome) =>
      sqliteHasActiveCredential(join(profileHome, ".local", "share", "opencode", "opencode.db"), "opencode"),
    processMarker: "opencode/bin/opencode",
    defaultCommand: [target, "--version"],
    // `--standalone` runs a private server instead of the managed background service. The managed service takes a
    // port derived from the release channel (49374 for `latest`), which the operator's own session may already hold;
    // the private server does not, so a login cannot fail on EADDRINUSE.
    loginCommand: [target, "auth", "login", "--standalone", "@TARGET@"],
    authStatusCommand: [target, "auth", "list"],
    timeoutMs: 120_000,
  };
}

/** Codex CLI: OpenAI Responses over the sanctioned ChatGPT flow. */
function codex(): ReconClient {
  const binary = resolveBinary("codex");
  const install = join(home, ".codex", "packages", "standalone", "releases");
  const target = `${INSTALL_ROOT}/codex/${relative(install, binary)}`;
  return {
    id: "codex",
    label: "Codex CLI",
    cell: "openai",
    gui: false,
    binary: { source: binary, target },
    versionArgs: ["--version"],
    readonlyBinds: [{ source: install, target: `${INSTALL_ROOT}/codex` }],
    guards: [
      join(home, ".codex"),
      join(home, ".config", "codex"),
      join(home, ".cache", "codex"),
      join(home, ".local", "state", "codex"),
    ],
    identityGuards: identityGuards(),
    env: {
      CODEX_HOME: `${HOME_IN_SANDBOX}/.codex`,
      // The binary names this variable itself; the shared CA variables do not reach a musl Rust TLS stack.
      CODEX_CA_CERTIFICATE: "/recon-ca.pem",
    },
    profileDirs: [".codex"],
    authMarkers: [".codex/auth.json"],
    processMarker: ".codex/packages/",
    defaultCommand: [target, "exec", "--skip-git-repo-check", "Reply with the single word: ok"],
    loginCommand: [target, "login"],
    authStatusCommand: [target, "login", "status"],
    timeoutMs: 120_000,
  };
}

/** Antigravity IDE: Gemini / Cloud Code Assist envelope through its Go language server. */
function antigravity(): ReconClient {
  const root = antigravityRoot();
  // Launch the Electron binary directly: `bin/antigravity-ide` is the CLI dispatcher and exits silently under a
  // sandboxed, display-only launch.
  const target = `${INSTALL_ROOT}/antigravity/antigravity-ide`;
  const userData = `${HOME_IN_SANDBOX}/.antigravity/user-data`;
  const cache = `${HOME_IN_SANDBOX}/.cache/Antigravity IDE`;
  const userState = `${HOME_IN_SANDBOX}/.antigravity-ide`;
  const guiFlags = [
    "--no-sandbox",
    "--disable-gpu",
    "--ozone-platform=x11",
    // The chat input is driven through the DevTools protocol, because the private display has no window manager and
    // coordinate clicks into the panel are a guess. The port is substituted per run.
    "--remote-debugging-port=@CDP_PORT@",
    // Chromium would otherwise try QUIC/HTTP3 straight to the upstream, bypassing the recorded proxy.
    "--disable-quic",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${userState}/extensions`,
    `--disk-cache-dir=${cache}`,
    `--crash-dumps-dir=${userState}/crashes`,
    "--skip-welcome",
    "--skip-release-notes",
    // The sandbox has no keyring by default and must never reach the operator's: `session: true` starts a private bus
    // and keyring inside the profile, and this flag points Chromium at it explicitly instead of letting detection pick.
    // Measured: without the keyring the token stayed in memory and the next launch started signed out again.
    "--password-store=gnome-libsecret",
    "--ignore-certificate-errors",
    // Some Electron network contexts ignore the flag above; the SPKI pin list covers the run's CA in every context.
    "--ignore-certificate-errors-spki-list=@CA_SPKI@",
  ];
  return {
    id: "antigravity",
    label: "Antigravity IDE",
    cell: "antigravity",
    gui: true,
    // The main window's title is the app name when no folder is open and the product name once one is: measured
    // `antigravity-ide` on a fresh profile and `Antigravity` on an opened workspace. The search is a regex.
    windowName: "[Aa]ntigravity",
    session: true,
    binary: { source: join(root, "antigravity-ide"), target },
    versionArgs: ["--version"],
    versionManifest: { path: join(root, "resources", "app", "package.json"), key: "version" },
    readonlyBinds: [{ source: root, target: `${INSTALL_ROOT}/antigravity` }],
    guards: [
      join(home, ".gemini"),
      join(home, ".config", "Antigravity IDE"),
      join(home, ".config", "Antigravity"),
      join(home, ".antigravity-ide"),
      join(home, ".cache", "Antigravity IDE"),
      join(home, ".cache", "Antigravity"),
      join(home, ".config", "gcloud"),
    ],
    identityGuards: identityGuards(),
    env: {},
    profileDirs: [
      ".gemini/antigravity-ide",
      ".gemini/config",
      ".config/Antigravity IDE",
      ".antigravity-ide/extensions",
      ".cache/Antigravity IDE",
    ],
    // Chromium keeps its safe-storage key in the user-data dir when no keyring is reachable, and Google credentials
    // have no single documented file name; presence is reported by profile growth instead.
    authMarkers: [],
    processMarker: "antigravity-ide",
    defaultCommand: [target, ...guiFlags, "--proxy-server=http://127.0.0.1:0"],
    loginCommand: [target, ...guiFlags],
    // The sign-in path as labels, in order: answer the workspace-trust modal, cancel the pre-2.0 settings migration
    // dialog (it appears on every launch until answered), then press the real sign-in button. Verified against 1.107.0.
    // "Continue with Google" only: the title-bar "Log in" is on screen from the first frame, opens Settings → Account,
    // and that page's "Sign In" never reaches the browser opener (measured), so accepting it as an alternative let the
    // driver stop early on a control that cannot sign in. The migration dialog does not need answering: a DOM click
    // reaches the button underneath it.
    loginButtons: ["?I trust the authors", "Continue with Google"],
    // Measured 2026-10-21 (seq 2103, 2215, 2284, 2293): every agent turn is `v1internal:streamGenerateContent`.
    turnRequest: String.raw`:streamGenerateContent\b`,
    // No credential marker: Antigravity keeps Google credentials in Electron safe storage, so a login is proven by the
    // client's own auth log, and by a real inference capture, rather than by a file we guessed the name of.
    loginSignals: [
      {
        // With `--user-data-dir` the logs live under it; a profile created before that flag kept them in `.config`.
        // Measured 2026-10-21: a fresh profile wrote `signedIn` only to `.antigravity/user-data/logs/<stamp>/auth.log`,
        // so a signal reading `.config` alone missed a completed login.
        glob: [".antigravity/user-data/logs/*/auth.log", ".config/Antigravity IDE/logs/*/auth.log"],
        statePattern: String.raw`Auth state changed to: (\w+)`,
        signedInState: "signedIn",
      },
    ],
    timeoutMs: 90_000,
    // Hosts read from the bundled Go language server (`language_server_linux_x64`) and from the R0 captures. Its
    // sign-in pages (accounts.google.com), telemetry and updater pass through untouched.
    interceptHosts: [
      String.raw`daily-cloudcode-pa\.googleapis\.com`,
      String.raw`cloudcode-pa\.googleapis\.com`,
      String.raw`www\.googleapis\.com`,
      String.raw`oauth2\.googleapis\.com`,
      String.raw`sts\.googleapis\.com`,
      String.raw`iamcredentials\.googleapis\.com`,
      String.raw`aiplatform\.googleapis\.com`,
      String.raw`businessaicode\.googleapis\.com`,
      String.raw`play\.googleapis\.com`,
      String.raw`antigravity-unleash\.goog`,
    ].join("|"),
  };
}

/** Placeholder in a client's login command replaced by `--target`. */
export const LOGIN_TARGET = "@TARGET@";

/**
 * Resolve a client's login command, substituting the requested integration.
 *
 * With no target the placeholder is dropped, which leaves the client's own interactive chooser in charge. The command
 * is data; this function is the only place that knows about the placeholder.
 */
export function resolveLoginCommand(client: ReconClient, target?: string): string[] {
  const command: string[] = [];
  for (const arg of client.loginCommand) {
    if (arg === LOGIN_TARGET) {
      if (target !== undefined && target.trim() !== "") command.push(target);
      continue;
    }
    command.push(arg);
  }
  return command;
}

const BUILDERS: Record<string, () => ReconClient> = {
  opencode,
  antigravity,
  claude,
  codex,
};

/** All clients that are installed, keyed by id. A client that is not installed is simply absent. */
export function allClients(): Record<string, ReconClient> {
  const built: Record<string, ReconClient> = {};
  for (const [id, build] of Object.entries(BUILDERS)) {
    try {
      built[id] = build();
    } catch {
      // Not installed on this machine; `clients` reports it and `clientById` names it.
    }
  }
  return built;
}

/** One client by id. */
export function clientById(id: string): ReconClient {
  const build = BUILDERS[id];
  if (!build) {
    throw new Error(`unknown client ${id}; expected one of ${Object.keys(BUILDERS).join(", ")}`);
  }
  return build();
}

/** Every real path a run must leave untouched: client state plus operator identity. */
export function guardedPaths(client: ReconClient): string[] {
  return [...client.guards, ...client.identityGuards];
}

/** Version reported by the installed client itself, or by its manifest for GUI apps. */
export function detectVersion(client: ReconClient): string {
  if (client.versionManifest) {
    const manifest = JSON.parse(readFileSync(client.versionManifest.path, "utf8")) as Record<string, unknown>;
    return String(manifest[client.versionManifest.key]);
  }
  const output = execFileSync(client.binary.source, [...client.versionArgs], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return output.trim().split("\n")[0]!.trim();
}
