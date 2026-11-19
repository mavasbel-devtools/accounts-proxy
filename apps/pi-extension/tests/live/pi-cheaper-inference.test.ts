// Live tier for pi-inference (uc-pi-5) on cheaper-inference through the real pi
// 1.5.2 binary (plan 2026-11-15-23-52 step 8.1r: A3 as amended by 8.0). Runs only
// with ACCOUNTS_PROXY_LIVE=1; without it every test skips.
//
// Cell derivation (briefs/8.1r/ranks81r.log over {logs}/catalog.json with the real
// PiConfigCodec): cheaper-inference routes 301 models to openai-completions and 5
// to openai-responses; the planned x anthropic-messages cell is ABSENT (zero
// routed models in the codec matrix — jq evidence in
// briefs/8.1r/absent-cells-jq.log) and is left out, never invented. All 306
// catalog models have toolCall:null, reasoning:null and cost:null, so NO model
// qualifies for the (b) tool turn or the (c) thinking turn (rule: gateways pick
// among toolCall:true / reasoning:true); both are left out, never invented. The
// (a) plain turns below run on the first-by-id codec-routed real model of each
// routed cell (ranks81r.log) and may fail live if the model refuses pi's tool
// list — flagged for step 8.3. Output cap 32 via per-provider modelOverrides.
// The (d)/(e) negatives need no model and are unchanged.
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

/** First-by-id codec-routed real model per routed cell (ranks81r.log). */
const CELLS = [
  { api: "openai-completions", model: "ap-cheaper-inference/cheaper-inference/ampersand-v0.1", id: "cheaper-inference/ampersand-v0.1" },
  { api: "openai-responses", model: "ap-cheaper-inference/cheaper-inference/gpt-5.1-codex", id: "cheaper-inference/gpt-5.1-codex" },
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

function writeCap(dir: string, ids: readonly string[]): void {
  const overrides: Record<string, { maxTokens: number }> = {};
  for (const id of ids) overrides[id] = { maxTokens: MAX_TOKENS };
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "ap-cheaper-inference": { modelOverrides: overrides } } }));
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

describe("pi inference on cheaper-inference (live)", () => {
  for (const cell of CELLS) {
    test.skipIf(!live)(
      `cheaper-inference x ${cell.api}: a plain turn answers OK [feature=pi-inference use-case=uc-pi-5 tier=live dependency=cheaper-inference polarity=positive]`,
      async () => {
        const dir = freshAgentDir();
        writeCap(dir, [cell.id]);
        const result = await runPi(["-e", EXTENSION, ...MINIMAL_FLAGS, "-p", "--model", cell.model, "Reply with exactly: OK"], {
          PI_CODING_AGENT_DIR: dir,
        });
        expect(result.code).toBe(0);
        expect(result.out).toContain("OK");
      },
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!live)(
    "cheaper-inference: a wrong token is a 401 before any upstream call [feature=pi-inference use-case=uc-pi-5 tier=live dependency=cheaper-inference polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const { doc } = await staticDocument();
      (doc.providers["ap-cheaper-inference"] as Record<string, unknown>)["modelOverrides"] = { [CELLS[0]!.id]: { maxTokens: MAX_TOKENS } };
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
    "cheaper-inference: an unknown model names unknown model [feature=pi-inference use-case=uc-pi-5 tier=live dependency=cheaper-inference polarity=negative]",
    async () => {
      const dir = freshAgentDir();
      const { doc, token } = await staticDocument();
      const models = doc.providers["ap-cheaper-inference"]!["models"] as { id: string; api: string; baseUrl: string; name?: string }[];
      const template = models.find((m) => m.id === CELLS[0]!.id) ?? models[0]!;
      models.push({ ...template, id: "cheaper-inference/nosuch", name: "nosuch" });
      (doc.providers["ap-cheaper-inference"] as Record<string, unknown>)["modelOverrides"] = { [CELLS[0]!.id]: { maxTokens: MAX_TOKENS } };
      writeFileSync(join(dir, "models.json"), JSON.stringify(doc));
      const result = await runPi(["-p", ...MINIMAL_FLAGS, "--model", "ap-cheaper-inference/cheaper-inference/nosuch", "Reply with exactly: OK"], {
        PI_CODING_AGENT_DIR: dir,
        ACCOUNTS_PROXY_TOKEN: token,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/nosuch/);
    },
    TEST_TIMEOUT_MS,
  );
});
