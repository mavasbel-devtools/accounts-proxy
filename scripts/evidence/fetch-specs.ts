// P0-E1: fetch the official wire specifications into docs/reference/specs/ with provenance
// (URL, HTTP status, byte size, SHA-256, fetch time; GitHub-hosted specs also record the commit SHA).
// `--only=<file>[,<file>]` fetches just those files and keeps every other manifest entry (and file) unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "..", "docs", "reference", "specs");
mkdirSync(out, { recursive: true });

/** `extract` keeps only part of a large body on disk; the manifest records the SHA-256 of both the full download
 * (`sha256`) and the written extract (`extractSha256`). */
type Source = { file: string; url: string; commitOf?: { repo: string; branch: string; path: string }; extract?: (body: string) => string };

/** models.dev entries of the gateways the proxy serves (5 MB in full). */
const modelsDevGateways = (body: string): string => {
  const all = JSON.parse(body) as Record<string, unknown>;
  const kept = Object.fromEntries(["opencode", "opencode-go", "openrouter"].map((id) => [id, all[id]]));
  return JSON.stringify(kept, null, 1) + "\n";
};

/** models.opencode.ai entries of the providers the proxy matches its models against (5.6 MB in full; plan
 * 2026-10-16 C0, decision E3): anthropic (claude), google (antigravity), openai, openrouter, opencode, opencode-go. */
const modelsOpencodeReference = (body: string): string => {
  const all = JSON.parse(body) as Record<string, unknown>;
  const kept = Object.fromEntries(["anthropic", "google", "openai", "openrouter", "opencode", "opencode-go"].map((id) => [id, all[id]]));
  return JSON.stringify(kept, null, 1) + "\n";
};

/** The `<main>` element of a documentation page that has no Markdown variant (the site chrome is left out). */
const mainElement = (body: string): string => {
  const match = /<main[\s\S]*<\/main>/.exec(body);
  if (match === null) throw new Error("no <main> element");
  return match[0] + "\n";
};

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
  { file: "openai-siwc-overview.md", url: "https://developers.openai.com/siwc/token-sharing-open-source.md" },
  { file: "openai-siwc-sign-in.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md" },
  { file: "openai-siwc-accounts-and-sessions.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md" },
  { file: "openai-siwc-models-and-inference.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md" },
  { file: "openai-siwc-codex-app-server.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md" },
  { file: "openai-siwc-self-hosted-vms.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md" },
  { file: "openai-siwc-token-reference.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md" },
  { file: "openai-siwc-errors-and-recovery.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md" },
  { file: "openai-siwc-preview-limitations.md", url: "https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md" },
  { file: "openai-siwc-ui-ux-guidelines.md", url: "https://developers.openai.com/siwc/ui-ux-guidelines.md" },
  // Plan P4.6: API-key gateways.
  { file: "openrouter-openapi.yaml", url: "https://openrouter.ai/docs/openapi/openapi.yaml" },
  { file: "openrouter-models.json", url: "https://openrouter.ai/api/v1/models" },
  { file: "openrouter-oauth-pkce.md", url: "https://openrouter.ai/docs/guides/overview/auth/oauth.md" },
  { file: "openrouter-authentication.md", url: "https://openrouter.ai/docs/api_reference/authentication.md" },
  { file: "openrouter-streaming.md", url: "https://openrouter.ai/docs/api_reference/streaming.md" },
  { file: "openrouter-errors.md", url: "https://openrouter.ai/docs/api_reference/errors-and-debugging.md" },
  { file: "openrouter-limits.md", url: "https://openrouter.ai/docs/api_reference/limits.md" },
  { file: "openrouter-models.md", url: "https://openrouter.ai/docs/guides/overview/models.md" },
  { file: "openrouter-free-variant.md", url: "https://openrouter.ai/docs/guides/routing/model-variants/free.md" },
  { file: "openrouter-claude-code.md", url: "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md" },
  { file: "cheaper-inference-llms-full.txt", url: "https://cheaperinference.com/llms-full.txt" },
  { file: "cheaper-inference-openapi.json", url: "https://api.cheaperinference.com/openapi.json" },
  { file: "cheaper-inference-public-models.json", url: "https://api.cheaperinference.com/public/models" },
  { file: "models-dev-gateways.json", url: "https://models.dev/api.json", extract: modelsDevGateways },
  // Plan 2026-10-16 (detailed model catalog, opencode configuration): opencode v2's model catalog and config schema.
  { file: "models-opencode-reference.json", url: "https://models.opencode.ai/api.json", extract: modelsOpencodeReference },
  { file: "opencode-config-schema.json", url: "https://opencode.ai/config.json" },
  // Plan P4.6 amendment A: the 2026-10-12 OpenCode Console (new inference addresses, device login, service-account keys).
  { file: "opencode-zen-models.json", url: "https://opencode.ai/inference/v1/models" },
  { file: "opencode-go-models.json", url: "https://opencode.ai/inference/go/v1/models" },
  { file: "opencode-console-intro.html", url: "https://opencode.ai/v2/docs/console/", extract: mainElement },
  { file: "opencode-console-api.html", url: "https://opencode.ai/v2/docs/console/api/", extract: mainElement },
  { file: "opencode-console-inference-api.html", url: "https://opencode.ai/v2/docs/console/api/inference/", extract: mainElement },
  { file: "opencode-console-models.html", url: "https://opencode.ai/v2/docs/console/models/", extract: mainElement },
  { file: "opencode-console-go.html", url: "https://opencode.ai/v2/docs/console/go/", extract: mainElement },
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
  const written = source.extract ? source.extract(body) : body;
  writeFileSync(join(out, source.file), written);
  manifest.push({
    file: source.file,
    url: source.url,
    status: res.status,
    contentType: res.headers.get("content-type"),
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
    ...(source.extract ? { extractBytes: Buffer.byteLength(written), extractSha256: createHash("sha256").update(written).digest("hex") } : {}),
    commit: source.commitOf ? await commitSha(source.commitOf) : undefined,
    fetchedAt: new Date().toISOString(),
  });
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const m of manifest) console.log(`${m.file}\t${m.bytes}\t${String(m.sha256).slice(0, 12)}\t${m.commit ?? ""}`);
