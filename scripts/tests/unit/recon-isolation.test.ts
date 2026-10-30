// Isolation contract of the recon sandbox: what the bwrap argv guarantees, what a profile carries, and what every
// client declares. These are pure checks; the authoritative in-sandbox probe is exercised by
// `bun scripts/recon/cli.ts isolation` because it needs bubblewrap and the installed clients.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBwrapArgv, isolatedEnv } from "@accounts-proxy/scripts/recon/sandbox/bwrap.ts";
import { changedPaths, fingerprintPath, snapshotPaths } from "@accounts-proxy/scripts/recon/sandbox/guard.ts";
import { attributeChanges, ownerOfPath } from "@accounts-proxy/scripts/recon/sandbox/live.ts";
import type { ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";
import {
  acquireProfileLock,
  assertIsolatedProfile,
  ensureProfile,
  hostnameOf,
  identityFiles,
  machineIdOf,
  profileFor,
  reconRoot,
  releaseProfileLock,
  resetProfile,
} from "@accounts-proxy/scripts/recon/sandbox/profiles.ts";
import {
  HOME_IN_SANDBOX,
  type SandboxSpec,
} from "@accounts-proxy/scripts/recon/sandbox/types.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let root: string | undefined;
let previousRoot: string | undefined;

afterEach(() => {
  if (root !== undefined) removeTemporary(root);
  root = undefined;
  if (previousRoot === undefined) delete process.env.ACCOUNTS_PROXY_RECON_ROOT;
  else process.env.ACCOUNTS_PROXY_RECON_ROOT = previousRoot;
  previousRoot = undefined;
});

function sandboxRoot(): string {
  root = makeTemporary("recon-isolation");
  previousRoot = process.env.ACCOUNTS_PROXY_RECON_ROOT;
  process.env.ACCOUNTS_PROXY_RECON_ROOT = root;
  return root;
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    profileHome: "/tmp/profile/home",
    hostname: "sandbox-0123456789ab",
    workdir: "/tmp/run/work",
    systemBinds: ["/usr", "/etc"],
    readonlyBinds: [{ source: "/tmp/ca.pem", target: "/recon-ca.pem" }],
    writableBinds: [{ source: "/tmp/.X11-unix", target: "/tmp/.X11-unix" }],
    tmpfs: ["/tmp"],
    env: isolatedEnv("http://127.0.0.1:8080"),
    command: ["/bin/sh", "-c", "true"],
    ...overrides,
  };
}

describe("bwrap argv", () => {
  test("clears the environment before setting any variable", () => {
    const argv = buildBwrapArgv(spec());
    const clear = argv.indexOf("--clearenv");
    const firstSet = argv.indexOf("--setenv");
    expect(clear).toBeGreaterThan(-1);
    expect(firstSet).toBeGreaterThan(clear);
  });

  test("mounts an empty /home before the profile, so the real home is never visible", () => {
    const argv = buildBwrapArgv(spec());
    const home = argv.findIndex((value, index) => value === "--tmpfs" && argv[index + 1] === "/home");
    const profile = argv.findIndex((value, index) => value === "--bind" && argv[index + 1] === "/tmp/profile/home");
    expect(home).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(home);
  });

  test("applies /tmp before the X11 bind, so the socket survives", () => {
    const argv = buildBwrapArgv(spec());
    const tmp = argv.findIndex((value, index) => value === "--tmpfs" && argv[index + 1] === "/tmp");
    const x11 = argv.findIndex((value, index) => value === "--bind" && argv[index + 1] === "/tmp/.X11-unix");
    expect(tmp).toBeGreaterThan(-1);
    expect(x11).toBeGreaterThan(tmp);
  });

  test("sets the sandbox hostname and a private /dev/shm", () => {
    const argv = buildBwrapArgv(spec());
    expect(argv).toContain("--hostname");
    expect(argv[argv.indexOf("--hostname") + 1]).toBe("sandbox-0123456789ab");
    expect(argv).toContain("/dev/shm");
  });

  test("passes environment variables in sorted order", () => {
    const argv = buildBwrapArgv(spec({ env: { ZED: "1", ALPHA: "2", MIDDLE: "3" } }));
    const setenv = argv.reduce<string[]>((names, value, index) => {
      if (value === "--setenv") names.push(argv[index + 1]!);
      return names;
    }, []);
    // HOME is emitted with the profile mount; the spec's own variables follow in sorted order.
    expect(setenv.filter((name) => name !== "HOME")).toEqual(["ALPHA", "MIDDLE", "ZED"]);
  });

  test("the shared environment points every state directory into the profile", () => {
    const env = isolatedEnv("http://127.0.0.1:9090");
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
      expect(env[name]!.startsWith(HOME_IN_SANDBOX)).toBe(true);
    }
    expect(env.USER).toBe("recon");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9090");
    // Every TLS stack the four clients use reads one of these.
    expect(env.SSL_CERT_FILE).toBe("/recon-ca.pem");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/recon-ca.pem");
    expect(env.CURL_CA_BUNDLE).toBe("/recon-ca.pem");
  });
});

describe("profiles", () => {
  test("creates owner-only directories and a stable identity", () => {
    sandboxRoot();
    const profile = profileFor("claude");
    ensureProfile(profile, [".claude"]);
    const mode = statSync(profile.dir).mode & 0o777;
    expect(mode).toBe(0o700);
    expect(statSync(join(profile.home, ".claude")).mode & 0o777).toBe(0o700);
    expect(statSync(profile.home).mode & 0o777).toBe(0o700);

    const id = machineIdOf(profile);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(identityFiles(profile).machineId).mode & 0o777).toBe(0o600);
    expect(hostnameOf(profile)).toBe(`sandbox-${id.slice(0, 12)}`);

    const passwd = readFileSync(identityFiles(profile).passwd, "utf8");
    expect(passwd).toContain("recon:x:");
    expect(passwd).not.toContain("mavasbel");
    expect(readFileSync(identityFiles(profile).hostname, "utf8").trim()).toBe(hostnameOf(profile));
  });

  test("keeps the machine id and hostname stable across calls", () => {
    sandboxRoot();
    const profile = profileFor("codex");
    ensureProfile(profile);
    const first = machineIdOf(profile);
    ensureProfile(profile);
    expect(machineIdOf(profile)).toBe(first);
  });

  test("refuses a profile outside the recon root", () => {
    sandboxRoot();
    const escaped = { client: "x", dir: "/tmp", home: "/tmp/home", tmp: "/tmp/tmp", work: "/tmp/work" };
    expect(() => assertIsolatedProfile(escaped)).toThrow(/not under/);
  });

  test("reclaims a stale run lock and refuses a live one", () => {
    sandboxRoot();
    const profile = profileFor("claude");
    ensureProfile(profile);
    const first = acquireProfileLock(profile);
    expect(existsSync(first)).toBe(true);
    expect(() => acquireProfileLock(profile)).toThrow(/another recon run holds the profile/);
    // A pid that cannot be alive (above the kernel's pid_max ceiling) makes the lock stale.
    writeFileSync(first, "4194305\n");
    const reclaimed = acquireProfileLock(profile);
    expect(readFileSync(reclaimed, "utf8").trim()).toBe(String(process.pid));
    releaseProfileLock(reclaimed);
    expect(existsSync(reclaimed)).toBe(false);
  });

  test("refuses a profile that is the real home", () => {
    sandboxRoot();
    const real = { client: "x", dir: "/", home: process.env.HOME!, tmp: "/tmp", work: "/tmp" };
    expect(() => assertIsolatedProfile(real)).toThrow(/real home/);
  });

  test("reset removes only the profile", () => {
    sandboxRoot();
    const profile = profileFor("opencode");
    ensureProfile(profile);
    writeFileSync(join(profile.home, "auth.json"), "{}");
    resetProfile(profile);
    expect(existsSync(profile.dir)).toBe(false);
    expect(reconRoot()).toBe(root!);
  });

  test("recon root (plan 2026-10-29-14-38 S2): ACCOUNTS_PROXY_RECON_ROOT, else ACCOUNTS_PROXY_HOME/recon, else the repository's .cache/recon", () => {
    const saved = { root: process.env.ACCOUNTS_PROXY_RECON_ROOT, home: process.env.ACCOUNTS_PROXY_HOME };
    try {
      process.env.ACCOUNTS_PROXY_RECON_ROOT = " ";
      process.env.ACCOUNTS_PROXY_HOME = "/x/data";
      expect(reconRoot()).toBe("/x/data/recon");
      delete process.env.ACCOUNTS_PROXY_RECON_ROOT;
      delete process.env.ACCOUNTS_PROXY_HOME;
      expect(reconRoot()).toBe(join(import.meta.dir, "..", "..", "..", ".cache", "recon"));
    } finally {
      process.env.ACCOUNTS_PROXY_RECON_ROOT = saved.root!;
      if (saved.home === undefined) delete process.env.ACCOUNTS_PROXY_HOME;
      else process.env.ACCOUNTS_PROXY_HOME = saved.home;
    }
  });
});

describe("change attribution", () => {
  const fake = (id: string, guards: string[], marker: string): ReconClient => ({
    id,
    label: id,
    cell: id,
    gui: false,
    binary: { source: "/bin/true", target: "/clients/true" },
    versionArgs: ["--version"],
    readonlyBinds: [],
    guards,
    identityGuards: [],
    env: {},
    profileDirs: [],
    authMarkers: [],
    defaultCommand: ["/bin/true"],
    loginCommand: ["/bin/true"],
    timeoutMs: 1_000,
    processMarker: marker,
  });

  test("attributes a changed path to its owning client", () => {
    sandboxRoot();
    const home = join(root!, "home");
    const mine = fake("a", [join(home, ".a")], "__never_a_process__");
    const other = fake("b", [join(home, ".b")], "__never_a_process__");
    expect(ownerOfPath(join(home, ".a", "state", "db"), [mine, other])?.id).toBe("a");
    expect(ownerOfPath(join(home, ".b"), [mine, other])?.id).toBe("b");
    expect(ownerOfPath(join(home, ".c"), [mine, other])).toBeUndefined();
  });

  test("a path with no running owner stays unexplained", () => {
    sandboxRoot();
    writeFileSync(join(root!, "marker"), "x");
    const client = fake("a", [join(root!, "state")], "__never_a_process__");
    const result = attributeChanges([join(root!, "state", "db")], [client]);
    expect(result.live).toEqual([]);
    expect(result.unexplained).toEqual([join(root!, "state", "db")]);
  });

  test("attributes a path to a daemon that holds it open without naming the client", async () => {
    sandboxRoot();
    // The Codex managed daemon runs from `~/.codex/packages/...` and keeps the log database open there. Its command
    // line does not contain the client's marker path either, so only the open descriptor can attribute the write.
    const state = join(root!, "state");
    mkdirSync(state, { recursive: true });
    const held = join(state, "logs.sqlite");
    writeFileSync(held, "x");
    const child = spawn("/bin/sh", ["-c", `exec 3<>"${held}"; sleep 5 & wait`], { stdio: "ignore" });
    try {
      await Bun.sleep(100);
      const client = fake("a", [state], "__never_a_process__");
      const result = attributeChanges([join(state, "logs.sqlite")], [client]);
      expect(result.live).toEqual([join(state, "logs.sqlite")]);
      expect(result.unexplained).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("attributes a path to a client that is running on the host", async () => {
    sandboxRoot();
    // A marker that exists in exactly one process: the shell started here. The shell stays alive and forks `sleep`,
    // so the marker is not replaced by an exec. Nothing else on the host can carry this value.
    const marker = `recon-marker-${process.pid}-${Date.now()}`;
    const child = spawn("/bin/sh", ["-c", "sleep 5 & wait", marker], { stdio: "ignore" });
    try {
      await Bun.sleep(100);
      const client = fake("a", [join(root!, "state")], marker);
      const result = attributeChanges([join(root!, "state", "db")], [client]);
      expect(result.live).toEqual([join(root!, "state", "db")]);
      expect(result.unexplained).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("guard", () => {
  test("detects a content change, an addition and a removal", () => {
    sandboxRoot();
    const dir = join(root!, "watched");
    writeFileSync(join(root!, "file.txt"), "one");
    const before = snapshotPaths([dir, join(root!, "file.txt"), join(root!, "absent")]);
    writeFileSync(join(root!, "file.txt"), "two");
    writeFileSync(join(root!, "absent"), "x");
    const after = snapshotPaths([dir, join(root!, "file.txt"), join(root!, "absent")]);
    expect(changedPaths(before, after).sort()).toEqual([join(root!, "absent"), join(root!, "file.txt")].sort());
    expect(fingerprintPath(join(root!, "file.txt")).exists).toBe(true);
  });
});
