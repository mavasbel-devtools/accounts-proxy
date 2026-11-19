// Live tier for pi-inference (uc-pi-5) on opencode-go x all four pi apis through
// the real pi 1.5.2 binary (plan 2026-11-15-23-52 step 8.1r: A3 as amended by
// 8.0). Runs only with ACCOUNTS_PROXY_LIVE=1; without it every test skips.
//
// Cell derivation (briefs/8.1r/ranks81r.log over {logs}/catalog.json with the real
// PiConfigCodec): opencode-go routes 6 models to anthropic-messages, 6 to
// openai-responses, 26 to openai-completions and 2 to google-generative-ai. Per
// cell, the cheapest toolCall:true model by A3 cost ranking (sum, then cacheRead,
// then id): anthropic-messages opencode-go/claude-haiku-5-5, openai-responses
// opencode-go/crouton-alpha-free, openai-completions opencode-go/beam-free,
// google-generative-ai opencode-go/gemini-4-argon. One paid tool turn (b) per
// cell; the plain turns (a) are removed per A3.
//
// Thinking turns (c), one per pi api on the cheapest codec-level reasoning:true
// model of that api across the whole table (ranks81r.log): this file holds two —
// openai-responses opencode-go/crouton-alpha-free (map holds minimal, so
// --thinking minimal with cap 32) and openai-completions opencode-go/beam-free
// (map lacks minimal, so the lowest mapped level :low via the model suffix with
// cap 32). The anthropic-messages and google-generative-ai thinking turns live in
// pi-opencode.test.ts. Negatives (d) and (e) cost nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTemporary, removeTemporary } from "@accounts-proxy/test-support/temporary.ts";

const live = process.env.ACCOUNTS_PROXY_LIVE === "1";
const PI = "/opt/homebrew/bin/pi";
const EXTENSION = join(import.meta.dir, "..", "..", "src", "main", "extension.ts");
const DAEMON = process.env.ACCOUNTS_PROXY_URL ?? "http://127.0.0.1:4141";
const TEST_TIMEOUT_MS = 120_000;
const PI_KILL_MS = 115_000;
const MAX_TOKENS = 32;
/** Tool turns carry the call and the answer: 32 truncates, 64 proven (8.3 E1 2026-11-16). */
const TOOL_TOKENS = 64;

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

/** One row per codec-routed cell: the (b) tool model. */
const CELLS = [
  { api: "anthropic-messages", model: "ap-opencode-go/opencode-go/claude-haiku-5-5", id: "opencode-go/claude-haiku-5-5" },
  { api: "openai-responses", model: "ap-opencode-go/opencode-go/crouton-alpha-free", id: "opencode-go/crouton-alpha-free" },
  { api: "openai-completions", model: "ap-opencode-go/opencode-go/beam-free", id: "opencode-go/beam-free" },
  { api: "google-generative-ai", model: "ap-opencode-go/opencode-go/gemini-4-argon", id: "opencode-go/gemini-4-argon" },
] as const;

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

function writeCap(dir: string, ids: readonly string[], cap: number = MAX_TOKENS): void {
  const overrides: Record<string, { maxTokens: number }> = {};
  for (const id of ids) overrides[id] = { maxTokens: cap };
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "ap-opencode-go": { modelOverrides: overrides } } }));
}

type Manifest = { auth: { command: string[]; env: string }; config: { url: string } };
type StaticDoc = { providers: Record<string, Record<string, unknown>> };

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

async function staticDocument(): Promise<{ doc: StaticDoc; token: string }> {
  const manifestDoc = (await (await fetch(`${DAEMON}/.well-known/pi`)).json()) as Manifest;
  const token = await daemonToken(manifestDoc);
  const response = await fetch(manifestDoc.config.url, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return { doc: (await response.json()) as StaticDoc, token };
}

describe("pi inference on opencode-go (live)", () => {
  for (const cell of CELLS) {
    test.skipIf(!live)(
      `opencode-go x ${cell.api}: a tool turn reads the file and answers PINEAPPLE [feature=pi-inference use-case=uc-pi-5 tier=live dependency=opencode-go polarity=positive]`,
      async () => {
        const dir = freshAgentDir();
        writeCap(dir, [cell.id], TOOL_TOKENS);
        // Anthropic's safety filter refuses read-and-repeat turns whose path contains
        // "accounts-proxy" (proven 2026-11-16: identical turn refuses with the
        // makeTemporary path, passes with a neutral path), so the read target lives
        // in a neutrally-named sibling temp dir under the same tmp root.
        const neutralDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-read-")));
        agentDirs.push(neutralDir);
        const file = join(neutralDir, "pineapple.txt");
        writeFileSync(file, "PINEAPPLE\n");
        const result = await runPi(
          ["-e", EXTENSION, ...MINIMAL_FLAGS, "-p", "--model", cell.model, `Use the read tool on ${file} and reply with its single word`],
          { PI_CODING_AGENT_DIR: dir },
        );
        expect(result.code).toBe(0);
        expect(result.out.toUpperCase()).toContain("PINEAPPLE");
      },
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!live)(
    "opencode-go x openai-responses: a thinking turn with --thinking minimal answers [feature=pi-inference use-case=uc-pi-5 tier=live dependency=opencode-go polarity=positive]",
    async () => {
      const dir = freshAgentDir();
      writeCap(dir, ["opencode-go/crouton-alpha-free"]);
      const result = await runPi(
        ["-e", EXTENSION, ...MINIMAL_FLAGS, "-p", "--thinking", "minimal", "--model", "ap-opencode-go/opencode-go/crouton-alpha-free", "Reply with exactly: OK"],
        { PI_CODING_AGENT_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(result.out.trim().length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "opencode-go x openai-completions: a thinking turn at the lowest mapped level answers [feature=pi-inference use-case=uc-pi-5 tier=live dependency=opencode-go polarity=positive]",
    async () => {
      const dir = freshAgentDir();
      writeCap(dir, ["opencode-go/beam-free"]);
      const result = await runPi(
        ["-e", EXTENSION, ...MINIMAL_FLAGS, "-p", "--model", "ap-opencode-go/opencode-go/beam-free:low", "Reply with exactly: OK"],
        { PI_CODING_AGENT_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(result.out.trim().length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "opencode-go: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=live dependency=opencode-go polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const { doc } = await staticDocument();
      (doc.providers["ap-opencode-go"] as Record<string, unknown>)["modelOverrides"] = { [CELLS[0]!.id]: { maxTokens: MAX_TOKENS } };
      writeFileSync(join(dir, "models.json"), JSON.stringify(doc));
      const result = await runPi(["-p", ...MINIMAL_FLAGS, "--model", CELLS[0]!.model, "Reply with exactly: OK"], {
        PI_CODING_AGENT_DIR: dir,
        ACCOUNTS_PROXY_TOKEN: "wrong",
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/401|unauthorized/i);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!live)(
    "opencode-go: an unknown model names unknown model [feature=pi-inference use-case=uc-pi-5 tier=live dependency=opencode-go polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const { doc, token } = await staticDocument();
      const models = doc.providers["ap-opencode-go"]!["models"] as { id: string; api: string; baseUrl: string; name?: string }[];
      const template = models.find((m) => m.id === CELLS[0]!.id) ?? models[0]!;
      models.push({ ...template, id: "opencode-go/nosuch", name: "nosuch" });
      (doc.providers["ap-opencode-go"] as Record<string, unknown>)["modelOverrides"] = { [CELLS[0]!.id]: { maxTokens: MAX_TOKENS } };
      writeFileSync(join(dir, "models.json"), JSON.stringify(doc));
      const result = await runPi(["-p", ...MINIMAL_FLAGS, "--model", "ap-opencode-go/opencode-go/nosuch", "Reply with exactly: OK"], {
        PI_CODING_AGENT_DIR: dir,
        ACCOUNTS_PROXY_TOKEN: token,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/nosuch/);
    },
    TEST_TIMEOUT_MS,
  );
});
