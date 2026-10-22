// Login plumbing: the per-profile port that keeps opencode's managed service away from the operator's, the command
// substitution that makes `--target` work, and the provenance record that proves a login without storing a token.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLoginCommand, type ReconClient } from "@accounts-proxy/scripts/recon/clients.ts";
import {
  loginMarkers,
  loginSignalState,
  loginSignalsSignedIn,
  readLog,
  readLoginRecord,
  refreshLoginRecord,
  sqliteHasActiveCredential,
  writeLoginRecord,
} from "@accounts-proxy/scripts/recon/login.ts";
import { mergeSystemCaBundle } from "@accounts-proxy/scripts/recon/run.ts";
import { mergeJsonSetting } from "@accounts-proxy/scripts/recon/sandbox/settings.ts";
import {
  assertLoopbackPortFree,
  freeLoopbackPort,
  mergeServicePort,
} from "@accounts-proxy/scripts/recon/sandbox/ports.ts";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) removeTemporary(root);
  root = undefined;
});

function temporary(name: string): string {
  root = makeTemporary(name);
  return root;
}

function fakeClient(overrides: Partial<ReconClient> = {}): ReconClient {
  return {
    id: "fake",
    label: "Fake",
    cell: "fake",
    gui: false,
    binary: { source: "/bin/true", target: "/clients/true" },
    versionArgs: ["--version"],
    readonlyBinds: [],
    guards: [],
    identityGuards: [],
    env: {},
    profileDirs: [],
    authMarkers: [],
    defaultCommand: ["/bin/true"],
    loginCommand: ["/bin/true"],
    timeoutMs: 1_000,
    processMarker: "__never_fake_process__",
    ...overrides,
  };
}

describe("login command", () => {
  test("substitutes the requested integration", () => {
    const client = fakeClient({ loginCommand: ["/bin/tool", "auth", "login", "@TARGET@"] });
    expect(resolveLoginCommand(client, "opencode-go")).toEqual(["/bin/tool", "auth", "login", "opencode-go"]);
  });

  test("drops the placeholder when no target is given, leaving the client's chooser", () => {
    const client = fakeClient({ loginCommand: ["/bin/tool", "auth", "login", "@TARGET@"] });
    expect(resolveLoginCommand(client)).toEqual(["/bin/tool", "auth", "login"]);
    expect(resolveLoginCommand(client, "   ")).toEqual(["/bin/tool", "auth", "login"]);
  });

  test("opencode logs in with a private server, never the managed service", () => {
    // The managed service takes port 49374 on the `latest` channel; the operator's own session holds it on this host.
    const login = resolveLoginCommand(
      fakeClient({ loginCommand: ["/bin/opencode", "auth", "login", "--standalone", "@TARGET@"] }),
    );
    expect(login).toContain("--standalone");
  });

  test("leaves commands without a placeholder untouched", () => {
    const client = fakeClient({ loginCommand: ["/bin/tool", "login"] });
    expect(resolveLoginCommand(client, "ignored")).toEqual(["/bin/tool", "login"]);
  });
});

describe("system trust bundle", () => {
  test("appends the run CA to the host bundle 0600", () => {
    const dir = temporary("recon-ca");
    const host = join(dir, "system.pem");
    const run = join(dir, "run.pem");
    writeFileSync(host, "HOST-CA\n");
    writeFileSync(run, "RUN-CA\n");
    const merged = mergeSystemCaBundle(host, run, join(dir, "merged.pem"));
    expect(merged).toBe(join(dir, "merged.pem"));
    expect(readFileSync(merged!, "utf8")).toBe("HOST-CA\nRUN-CA\n");
    expect(statSync(merged!).mode & 0o777).toBe(0o600);
  });

  test("no bind when either input is missing", () => {
    const dir = temporary("recon-ca");
    writeFileSync(join(dir, "run.pem"), "RUN-CA\n");
    expect(mergeSystemCaBundle(join(dir, "absent.pem"), join(dir, "run.pem"), join(dir, "merged.pem"))).toBeUndefined();
  });
});

describe("profile service port", () => {  test("creates the file 0600 with the port", () => {
    const dir = temporary("recon-port");
    const file = join(dir, "service.json");
    mergeServicePort(file, 49517);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 49517 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("preserves every other key the client wrote", () => {
    const dir = temporary("recon-port");
    const file = join(dir, "service.json");
    writeFileSync(file, JSON.stringify({ port: 1, password: "keep-me" }));
    mergeServicePort(file, 49518);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 49518, password: "keep-me" });
  });

  test("replaces a file that is not a JSON object", () => {
    const dir = temporary("recon-port");
    const file = join(dir, "service.json");
    writeFileSync(file, "not json at all");
    mergeServicePort(file, 49519);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 49519 });
  });

  test("treats an empty file as empty settings", () => {
    const dir = temporary("recon-port");
    const file = join(dir, "service.json");
    writeFileSync(file, "  \n");
    mergeServicePort(file, 49520);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 49520 });
  });

  test("treats a JSON array as empty settings", () => {
    const dir = temporary("recon-port");
    const file = join(dir, "service.json");
    writeFileSync(file, "[]");
    mergeServicePort(file, 49521);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ port: 49521 });
  });
});

describe("loopback ports", () => {
  test("an ephemeral port is returned and immediately reusable", async () => {
    const port = await freeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    await assertLoopbackPortFree(port);
  });

  test("a held port is reported with its number", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(assertLoopbackPortFree(port)).rejects.toThrow(`port ${port} is already in use`);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe("login signal", () => {
  const signal = {
    glob: ".config/App/logs/*/auth.log",
    statePattern: String.raw`Auth state changed to: (\w+)`,
    signedInState: "signedIn",
  };

  function writeLog(home: string, run: string, lines: readonly string[], mtimeMs: number): string {
    const dir = join(home, ".config", "App", "logs", run);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "auth.log");
    writeFileSync(file, `${lines.map((line) => `2026-10-20 14:55:24 [info] [Auth] ${line}`).join("\n")}\n`);
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  test("the last state the client wrote is the answer", () => {
    const dir = temporary("recon-signal");
    writeLog(dir, "run-a", ["Auth state changed to: uninitialized", "Auth state changed to: signedIn"], 1_000);
    expect(loginSignalState(dir, signal)).toBe("signedIn");
  });

  test("the newest log wins over an older one that ended signed in", () => {
    const dir = temporary("recon-signal");
    writeLog(dir, "run-a", ["Auth state changed to: signedIn"], 1_000);
    writeLog(dir, "run-b", ["Auth state changed to: signedOut"], 2_000);
    expect(loginSignalState(dir, signal)).toBe("signedOut");
  });

  test("several globs are read together and the newest log across all of them decides", () => {
    // Measured on Antigravity 1.107.0: a profile started with `--user-data-dir` logs under it, an older one under
    // `.config`; a login written to the first must not be hidden by a stale signed-out log in the second.
    const dir = temporary("recon-signal-multi");
    writeLog(dir, "run-old", ["Auth state changed to: signedOut"], 1_000);
    const userData = join(dir, ".app", "user-data", "logs", "run-new");
    mkdirSync(userData, { recursive: true });
    const fresh = join(userData, "auth.log");
    writeFileSync(fresh, "2026-10-21 01:35:21 [info] [Auth] Auth state changed to: signedIn\n");
    utimesSync(fresh, 2, 2);
    const both = { ...signal, glob: [".app/user-data/logs/*/auth.log", signal.glob] };
    expect(loginSignalState(dir, both)).toBe("signedIn");
    expect(loginSignalsSignedIn(dir, [both])).toBe(true);
    expect(loginSignalState(dir, signal)).toBe("signedOut");
  });

  test("a log with no state line, a directory in a log's place and a missing root all read as no state", () => {
    const dir = temporary("recon-signal");
    const noisy = writeLog(dir, "run-a", ["Auth state changed to: signedIn"], 1_000);
    mkdirSync(join(dir, ".config", "App", "logs", "run-c", "auth.log"), { recursive: true });
    utimesSync(noisy, 5_000, 5_000);
    expect(loginSignalState(dir, signal)).toBe("signedIn");

    const noMatch = temporary("recon-signal-nomatch");
    writeLog(noMatch, "run-a", ["Auth ready"], 1_000);
    expect(loginSignalState(noMatch, signal)).toBeUndefined();
    expect(loginSignalState(noMatch, { ...signal, statePattern: "Auth state changed to: signedIn" })).toBeUndefined();
    expect(loginSignalState(join(noMatch, "absent"), signal)).toBeUndefined();
  });

  test("a glob without a wildcard segment is followed, and so is a nested one", () => {
    const dir = temporary("recon-signal-flat");
    mkdirSync(join(dir, ".state"), { recursive: true });
    writeFileSync(join(dir, ".state", "auth.log"), "Auth state changed to: signedIn\n");
    expect(loginSignalState(dir, { ...signal, glob: ".state/auth.log" })).toBe("signedIn");
    expect(
      loginSignalState(dir, { ...signal, glob: ".config/App/logs/*/auth.log", statePattern: "signedIn" }),
    ).toBeUndefined();
  });

  test("every declared signal must report signed in, and at least one must be declared", () => {
    const dir = temporary("recon-signal-signin");
    writeLog(dir, "run-a", ["Auth state changed to: signedIn"], 1_000);
    expect(loginSignalsSignedIn(dir, [signal])).toBe(true);
    expect(loginSignalsSignedIn(dir, [])).toBe(false);
    expect(loginSignalsSignedIn(dir, [signal, { ...signal, glob: ".config/Other/auth.log" }])).toBe(false);
  });

  test("an unreadable log is empty, never a crash", () => {
    const dir = temporary("recon-signal-read");
    mkdirSync(join(dir, "as-a-directory"), { recursive: true });
    expect(readLog(join(dir, "as-a-directory"))).toBe("");
    expect(readLog(join(dir, "absent.log"))).toBe("");
  });
});

describe("login record", () => {
  test("hashes each marker and stores no content", () => {
    const dir = temporary("recon-login");
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const secret = "refresh-token-value-that-must-never-be-recorded";
    writeFileSync(join(home, ".claude", ".credentials.json"), secret);
    const markers = loginMarkers(home, [".claude/.credentials.json", ".claude/missing.json"]);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.path).toBe(".claude/.credentials.json");
    expect(markers[0]!.bytes).toBe(Buffer.byteLength(secret));
    expect(markers[0]!.sha256).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(markers)).not.toContain(secret);
  });

  test("round-trips through login.json 0600", () => {
    const dir = temporary("recon-login");
    const file = writeLoginRecord(dir, {
      client: "claude",
      version: "2.1.304",
      at: "2026-10-20T00:00:00.000Z",
      signedIn: true,
      markers: [{ path: ".claude/.credentials.json", bytes: 4, sha256: "ab" }],
      openUrls: ["https://example.test/login"],
      exitCode: 0,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const record = readLoginRecord(dir);
    expect(record?.schema).toBe("recon-login/1");
    expect(record?.signedIn).toBe(true);
    expect(record?.markers[0]?.sha256).toBe("ab");
  });

  test("no record and a malformed record both read as absent", () => {
    const dir = temporary("recon-login");
    expect(readLoginRecord(dir)).toBeUndefined();
    writeFileSync(join(dir, "login.json"), "{");
    expect(readLoginRecord(dir)).toBeUndefined();
  });

  test("an active credential is read from the profile database without touching its value", () => {
    const dir = temporary("recon-sqlite");
    const file = join(dir, "opencode.db");
    const db = new Database(file);
    db.run("create table credential (id text, integration_id text, active integer)");
    db.run("insert into credential values ('a', 'opencode', 0)");
    expect(sqliteHasActiveCredential(file, "opencode")).toBe(false);
    db.run("insert into credential values ('b', 'opencode', 1)");
    db.run("insert into credential values ('c', 'other', 1)");
    db.close();
    expect(sqliteHasActiveCredential(file, "opencode")).toBe(true);
    expect(sqliteHasActiveCredential(file, "missing")).toBe(false);
    expect(sqliteHasActiveCredential(join(dir, "absent.db"), "opencode")).toBe(false);
  });

  test("a verify pass corrects the sign-in fields and keeps the record's provenance", () => {
    const dir = temporary("recon-refresh");
    writeLoginRecord(dir, {
      client: "opencode",
      version: "opencode v2.1.1",
      at: "2026-10-20T18:20:30.833Z",
      signedIn: false,
      markers: [],
      openUrls: ["https://example.test/device"],
      exitCode: 0,
    });
    expect(refreshLoginRecord(dir, { signedIn: true, markers: [] })).toBeString();
    const record = readLoginRecord(dir);
    expect(record?.signedIn).toBe(true);
    expect(record?.at).toBe("2026-10-20T18:20:30.833Z");
    expect(record?.openUrls).toEqual(["https://example.test/device"]);
    expect(refreshLoginRecord(join(dir, "absent"), { signedIn: true, markers: [] })).toBeUndefined();
  });

  test("a setting is created in a new file, merged into an object and never written over unparseable or non-object JSON", () => {
    const dir = temporary("recon-settings");
    const fresh = join(dir, "User", "settings.json");
    expect(mergeJsonSetting(fresh, "security.workspace.trust.enabled", false)).toBe(true);
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ "security.workspace.trust.enabled": false });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "User")).mode & 0o777).toBe(0o700);

    expect(mergeJsonSetting(fresh, "editor.fontSize", 13)).toBe(true);
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({
      "security.workspace.trust.enabled": false,
      "editor.fontSize": 13,
    });

    const commented = join(dir, "commented.json");
    writeFileSync(commented, '{\n  // operator comment\n  "a": 1\n}\n');
    expect(mergeJsonSetting(commented, "b", 2)).toBe(false);
    expect(readFileSync(commented, "utf8")).toContain("// operator comment");

    const array = join(dir, "array.json");
    writeFileSync(array, "[]");
    expect(mergeJsonSetting(array, "b", 2)).toBe(false);
    expect(readFileSync(array, "utf8")).toBe("[]");
  });
});
