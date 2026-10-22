/**
 * Pure translation of a {@link SandboxSpec} into a bubblewrap argv.
 *
 * Isolation contract encoded here:
 *  - the environment is cleared (`--clearenv`), so only the spec's variables reach the client;
 *  - the host home is never bound; `/home` is an empty tmpfs and only the profile appears, at
 *    {@link HOME_IN_SANDBOX};
 *  - the root is bwrap's own tmpfs, so every host tree the client can see is named explicitly by the caller;
 *  - the network is shared (the MITM listens on loopback), every other namespace is unshared;
 *  - the process dies with the parent, so a crashed CLI cannot leave a client running.
 */

import {
  CA_IN_SANDBOX,
  HOME_IN_SANDBOX,
  OPEN_BIN_DIR_IN_SANDBOX,
  WORK_IN_SANDBOX,
  type SandboxSpec,
} from "@accounts-proxy/scripts/recon/sandbox/types.ts";

/** Flags that never vary between clients. */
const NAMESPACE_FLAGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-uts",
  "--unshare-ipc",
  "--unshare-cgroup-try",
  "--die-with-parent",
  "--new-session",
] as const;

/**
 * Build the argv for `bwrap`.
 *
 * Bind order matters: `/home` becomes a tmpfs before the profile is mounted into it, the caller's tmpfs list is
 * applied before the writable binds, and every writable bind is applied after the tmpfs it lands in. Mounting the
 * X11 socket before `--tmpfs /tmp`, for example, would hide the socket again.
 */
export function buildBwrapArgv(spec: SandboxSpec): string[] {
  const argv: string[] = [
    "bwrap",
    ...NAMESPACE_FLAGS,
    "--hostname",
    spec.hostname,
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];

  // Electron and Bun use shared memory; bwrap's minimal /dev has none.
  argv.push("--tmpfs", "/dev/shm");

  for (const tree of spec.systemBinds) {
    argv.push("--ro-bind", tree, tree);
  }

  argv.push("--tmpfs", "/home");
  argv.push("--bind", spec.profileHome, HOME_IN_SANDBOX, "--setenv", "HOME", HOME_IN_SANDBOX);

  for (const bind of spec.readonlyBinds) {
    argv.push("--ro-bind", bind.source, bind.target);
  }

  for (const tree of spec.tmpfs) {
    argv.push("--tmpfs", tree);
  }

  for (const bind of spec.writableBinds) {
    argv.push("--bind", bind.source, bind.target);
  }

  argv.push("--bind", spec.workdir, WORK_IN_SANDBOX, "--chdir", WORK_IN_SANDBOX);

  for (const [name, value] of Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("--setenv", name, value);
  }

  argv.push("--", ...spec.command);
  return argv;
}

/**
 * Environment shared by every client: profile-scoped XDG dirs, the proxy, the run CA, and the browser opener stub.
 *
 * The profile is the only writable home; `XDG_RUNTIME_DIR` is a 0700 directory inside it, so no client can reach the
 * host's `/run/user/<uid>` sockets (session bus, keyring, pipewire). `DISPLAY` is added by the caller when a client
 * needs a private X server.
 */
export function isolatedEnv(proxyUrl: string): Record<string, string> {
  return {
    HOME: HOME_IN_SANDBOX,
    PATH: `${OPEN_BIN_DIR_IN_SANDBOX}:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: `${HOME_IN_SANDBOX}/.config`,
    XDG_DATA_HOME: `${HOME_IN_SANDBOX}/.local/share`,
    XDG_STATE_HOME: `${HOME_IN_SANDBOX}/.local/state`,
    XDG_CACHE_HOME: `${HOME_IN_SANDBOX}/.cache`,
    XDG_RUNTIME_DIR: `${HOME_IN_SANDBOX}/.run`,
    TMPDIR: `${HOME_IN_SANDBOX}/tmp`,
    USER: "recon",
    LOGNAME: "recon",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    SSL_CERT_FILE: CA_IN_SANDBOX,
    NODE_EXTRA_CA_CERTS: CA_IN_SANDBOX,
    CURL_CA_BUNDLE: CA_IN_SANDBOX,
    GIT_SSL_CAINFO: CA_IN_SANDBOX,
    REQUESTS_CA_BUNDLE: CA_IN_SANDBOX,
    RECON_OPEN_URL_FILE: `${WORK_IN_SANDBOX}/open-url.log`,
    GIT_TERMINAL_PROMPT: "0",
  };
}
