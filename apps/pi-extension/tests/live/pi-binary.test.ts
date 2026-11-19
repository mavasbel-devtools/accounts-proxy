// Live tier for feature pi-extension (uc-pi-4, uc-pi-6) and pi-inference (uc-pi-5)
// through the real pi 1.5.2 binary (plan 2026-11-15-23-52 step 8.1r: A3 as amended
// by 8.0). Runs only with ACCOUNTS_PROXY_LIVE=1, like every live suite;
// without it every test skips. Never part of `verify`.
//
// The uc-pi-5 print turn uses the cheapest claude model by the A3 ranking
// (briefs/8.1r/ranks81r.log: all claude costs null, first by id). Output cap 32
// via per-provider modelOverrides. uc-pi-4 and uc-pi-6 are unchanged.
//
// Preconditions owned by step 8.2/8.3 (main session): the worktree daemon serves
// the live accounts on ACCOUNTS_PROXY_URL (default http://127.0.0.1:4141), and the
// ambient environment resolves the manifest's token command (absolute, so it runs
// from any directory; it inherits the test process environment).
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

const live = process.env.ACCOUNTS_PROXY_LIVE === "1";
const PI = "/opt/homebrew/bin/pi";
const EXTENSION = join(import.meta.dir, "..", "..", "src", "main", "extension.ts");
const DAEMON = process.env.ACCOUNTS_PROXY_URL ?? "http://127.0.0.1:4141";
const TEST_TIMEOUT_MS = 120_000;
const PI_KILL_MS = 115_000;
const MAX_TOKENS = 32;

/** Cheapest claude model by the A3 ranking (ranks81r.log): all costs null, first by id. */
const CHEAPEST_CLAUDE_ID = "claude/claude-fable-5";

const MINIMAL_FLAGS = [
  "--system-prompt",
  "Answer in one word.",
  "--tools",
  "read",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-mcp",
  "--no-extensions",
  "--no-session",
] as const;

const PROVIDERS = ["ap-claude", "ap-antigravity", "ap-openai", "ap-openrouter", "ap-opencode", "ap-opencode-go", "ap-cheaper-inference"] as const;

const agentDirs: string[] = [];
afterEach(() => {
  while (agentDirs.length > 0) removeTemporary(agentDirs.pop());
});

function freshAgentDir(): string {
  const dir = makeTemporary("pi-live");
  agentDirs.push(dir);
  return dir;
}

function spawnEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...extra };
}

async function runPi(args: readonly string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([PI, ...args], { env: spawnEnv(extraEnv), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), PI_KILL_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

/** A models.json that only caps the named ids (per-provider modelOverrides merge over the extension's models). */
function writeCap(dir: string, provider: string, ids: readonly string[]): void {
  const overrides: Record<string, { maxTokens: number }> = {};
  for (const id of ids) overrides[id] = { maxTokens: MAX_TOKENS };
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [`ap-${provider}`]: { modelOverrides: overrides } } }));
}

type Manifest = { auth: { command: string[]; env: string }; config: { url: string } };

async function daemonToken(manifestDoc: Manifest): Promise<string> {
  const child = Bun.spawn(manifestDoc.auth.command, { env: spawnEnv({}), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), PI_KILL_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

type StaticDoc = { providers: Record<string, Record<string, unknown>> };

/** The daemon's own pi document (byte-identical to `bun run proxy pi-config` per e2e), so no home path leaks into tests. */
async function staticDocument(): Promise<StaticDoc> {
  const manifestDoc = (await (await fetch(`${DAEMON}/.well-known/pi`)).json()) as Manifest;
  const token = await daemonToken(manifestDoc);
  const response = await fetch(manifestDoc.config.url, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as StaticDoc;
}

describe("pi binary and extension registration (live)", () => {
  test.skipIf(!live)(
    "uc-pi-4: --list-models ap- exits 0 and lists every available ap- provider [feature=pi-extension use-case=uc-pi-4 tier=live dependency=pi polarity=positive]",
    async () => {
      const dir = freshAgentDir();
      writeCap(dir, "claude", [CHEAPEST_CLAUDE_ID]);
      const result = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "--list-models", "ap-"], { PI_CODING_AGENT_DIR: dir });
      expect(result.code).toBe(0);
      for (const provider of PROVIDERS) expect(result.out).toContain(provider);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "uc-pi-4: against a dead proxy --list-models ap- exits 0 with no ap- line and stderr names accounts-proxy [feature=pi-extension use-case=uc-pi-4 tier=live dependency=pi polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const result = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "--list-models", "ap-"], {
        PI_CODING_AGENT_DIR: dir,
        ACCOUNTS_PROXY_URL: "http://127.0.0.1:9",
      });
      expect(result.code).toBe(0);
      expect(result.out.split("\n").filter((line) => line.includes("ap-") && !line.includes("no ap- providers registered"))).toEqual([]);
      expect(result.out).toMatch(/accounts-proxy/);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "uc-pi-6: through a counting forwarder --list-models ap- reaches count >= 2, via update --models when the first count is 1 [feature=pi-extension use-case=uc-pi-6 tier=live dependency=pi polarity=positive]",
    async () => {
      const hits = { n: 0 };
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const incoming = new URL(req.url);
          if (incoming.pathname === "/.well-known/pi") hits.n += 1;
          const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
          return fetch(`${DAEMON}${incoming.pathname}${incoming.search}`, { method: req.method, headers: req.headers, body });
        },
      });
      try {
        const url = `http://127.0.0.1:${server.port}`;
        const first = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "--list-models", "ap-"], {
          PI_CODING_AGENT_DIR: freshAgentDir(),
          ACCOUNTS_PROXY_URL: url,
        });
        expect(first.code).toBe(0);
        if (hits.n < 2) {
          const second = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "update", "--models"], {
            PI_CODING_AGENT_DIR: freshAgentDir(),
            ACCOUNTS_PROXY_URL: url,
          });
          expect(second.code).toBe(0);
        }
        expect(hits.n).toBeGreaterThanOrEqual(2);
      } finally {
        server.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "uc-pi-6: when /.well-known/pi 503s after the first answer --list-models ap- still exits 0 listing every provider [feature=pi-extension use-case=uc-pi-6 tier=live dependency=pi polarity=negative]",
    async () => {
      let n = 0;
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const incoming = new URL(req.url);
          if (incoming.pathname === "/.well-known/pi") {
            n += 1;
            if (n > 1) return new Response("unavailable", { status: 503 });
          }
          const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
          return fetch(`${DAEMON}${incoming.pathname}${incoming.search}`, { method: req.method, headers: req.headers, body });
        },
      });
      try {
        const result = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "--list-models", "ap-"], {
          PI_CODING_AGENT_DIR: freshAgentDir(),
          ACCOUNTS_PROXY_URL: `http://127.0.0.1:${server.port}`,
        });
        expect(result.code).toBe(0);
        for (const provider of PROVIDERS) expect(result.out).toContain(provider);
      } finally {
        server.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "uc-pi-5: a print turn on ap-claude/claude/claude-fable-5 answers OK [feature=pi-inference use-case=uc-pi-5 tier=live dependency=pi polarity=positive]",
    async () => {
      const dir = freshAgentDir();
      writeCap(dir, "claude", [CHEAPEST_CLAUDE_ID]);
      const result = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "-p", "--model", `ap-claude/${CHEAPEST_CLAUDE_ID}`, "Reply with exactly: OK"], {
        PI_CODING_AGENT_DIR: dir,
      });
      expect(result.code).toBe(0);
      expect(result.out).toContain("OK");
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "uc-pi-5: the static document with a wrong token fails naming 401 [feature=pi-inference use-case=uc-pi-5 tier=live dependency=pi polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const doc = await staticDocument();
      doc.providers["ap-claude"]!["modelOverrides"] = { [CHEAPEST_CLAUDE_ID]: { maxTokens: MAX_TOKENS } };
      writeFileSync(join(dir, "models.json"), JSON.stringify(doc));
      const result = await runPi(["-p", ...MINIMAL_FLAGS, "--model", `ap-claude/${CHEAPEST_CLAUDE_ID}`, "Reply with exactly: OK"], {
        PI_CODING_AGENT_DIR: dir,
        ACCOUNTS_PROXY_TOKEN: "wrong",
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/401|unauthorized/i);
    },
    TEST_TIMEOUT_MS,
  );
});
