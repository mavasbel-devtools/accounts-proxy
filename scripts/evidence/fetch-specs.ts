// P0-E1: fetch the official wire specifications into docs/reference/specs/ with provenance
// (URL, HTTP status, byte size, SHA-256, fetch time; GitHub-hosted specs also record the commit SHA).
// `--only=<file>[,<file>]` fetches just those files and keeps every other manifest entry (and file) unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "..", "docs", "reference", "specs");
mkdirSync(out, { recursive: true });

type Source = { file: string; url: string; commitOf?: { repo: string; branch: string; path: string } };

const sources: Source[] = [
  { file: "anthropic-messages.md", url: "https://platform.claude.com/docs/en/api/messages.md" },
  { file: "anthropic-streaming.md", url: "https://platform.claude.com/docs/en/build-with-claude/streaming.md" },
  { file: "anthropic-errors.md", url: "https://platform.claude.com/docs/en/api/errors.md" },
  { file: "anthropic-count-tokens.md", url: "https://platform.claude.com/docs/en/api/messages-count-tokens.md" },
  { file: "anthropic-models-list.md", url: "https://platform.claude.com/docs/en/api/models-list.md" },
  {
    file: "openai-openapi.yaml",
    url: "https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml",
    commitOf: { repo: "openai/openai-openapi", branch: "master", path: "openapi.yaml" },
  },
  { file: "gemini-generate-content.md", url: "https://ai.google.dev/api/generate-content.md.txt" },
  { file: "gemini-models.md", url: "https://ai.google.dev/api/models.md.txt" },
  { file: "gemini-tokens.md", url: "https://ai.google.dev/api/tokens.md.txt" },
  { file: "gemini-troubleshooting.md", url: "https://ai.google.dev/gemini-api/docs/troubleshooting.md.txt" },
  { file: "gemini-v1beta-discovery.json", url: "https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta" },
  {
    file: "google-rpc-code.proto",
    url: "https://raw.githubusercontent.com/googleapis/googleapis/master/google/rpc/code.proto",
    commitOf: { repo: "googleapis/googleapis", branch: "master", path: "google/rpc/code.proto" },
  },
];

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter((f) => f.length > 0);
const manifestPath = join(out, "manifest.json");
const previous: Record<string, unknown>[] = only.length > 0 && existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>[]) : [];

// The content SHA-256 is the authoritative identity of every fetched file. The commit lookup is
// supplementary: when GitHub's API cannot resolve the branch it is recorded as unresolved, never guessed.
async function commitSha(ref: NonNullable<Source["commitOf"]>): Promise<string> {
  const api = `https://api.github.com/repos/${ref.repo}/commits?sha=${ref.branch}&path=${ref.path}&per_page=1`;
  const res = await fetch(api, { headers: { accept: "application/vnd.github+json" } });
  if (res.status !== 200) return `unresolved (GitHub API HTTP ${res.status})`;
  const commits = (await res.json()) as { sha: string }[];
  return commits[0]?.sha ?? "unresolved (no commit returned)";
}

const manifest: Record<string, unknown>[] = [];
for (const source of sources) {
  if (only.length > 0 && !only.includes(source.file)) {
    const kept = previous.find((m) => m["file"] === source.file);
    if (kept !== undefined) manifest.push(kept);
    continue;
  }
  const res = await fetch(source.url);
  const body = await res.text();
  if (res.status !== 200) throw new Error(`${source.file}: HTTP ${res.status} ${source.url}`);
  writeFileSync(join(out, source.file), body);
  manifest.push({
    file: source.file,
    url: source.url,
    status: res.status,
    contentType: res.headers.get("content-type"),
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
    commit: source.commitOf ? await commitSha(source.commitOf) : undefined,
    fetchedAt: new Date().toISOString(),
  });
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const m of manifest) console.log(`${m.file}\t${m.bytes}\t${String(m.sha256).slice(0, 12)}\t${m.commit ?? ""}`);
