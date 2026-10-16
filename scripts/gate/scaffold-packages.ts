// One-shot P1 scaffold: writes each workspace package's package.json and its tests/{unit,component,live,e2e}
// skeleton. Idempotent: an existing package.json is left untouched, so it is safe to re-run.
// Only the layered workspaces are listed. tests/support (@inference-router/test-support) and scripts
// (@inference-router/scripts) are hand-maintained workspaces with no layers and no test tiers; a workspace whose
// tests import the shared fakes declares "@inference-router/test-support": "workspace:*" in devDependencies.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const packages: { dir: string; name: string; description: string; dependencies: string[] }[] = [
  { dir: "packages/core", name: "@inference-router/core", description: "Canonical domain model, errors and ports (stdlib only).", dependencies: [] },
  { dir: "packages/provider-claude", name: "@inference-router/provider-claude", description: "Claude subscription provider (outbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/provider-antigravity", name: "@inference-router/provider-antigravity", description: "Google Antigravity provider (outbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/provider-openai", name: "@inference-router/provider-openai", description: "OpenAI provider: Sign in with ChatGPT plan usage (outbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/provider-gateway", name: "@inference-router/provider-gateway", description: "Shared base of the API-key gateway providers (plan P4.6).", dependencies: ["@inference-router/core"] },
  { dir: "packages/provider-openrouter", name: "@inference-router/provider-openrouter", description: "OpenRouter provider (API-key gateway, PKCE login).", dependencies: ["@inference-router/core", "@inference-router/provider-gateway"] },
  { dir: "packages/provider-opencode", name: "@inference-router/provider-opencode", description: "OpenCode Zen and Go providers (API-key gateways).", dependencies: ["@inference-router/core", "@inference-router/provider-gateway"] },
  { dir: "packages/provider-cheaper-inference", name: "@inference-router/provider-cheaper-inference", description: "Cheaper Inference provider (API-key gateway).", dependencies: ["@inference-router/core", "@inference-router/provider-gateway"] },
  { dir: "packages/dialect-anthropic", name: "@inference-router/dialect-anthropic", description: "Anthropic Messages dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-openai", name: "@inference-router/dialect-openai", description: "OpenAI Chat Completions dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-gemini", name: "@inference-router/dialect-gemini", description: "Gemini generateContent dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-opencode", name: "@inference-router/dialect-opencode", description: "opencode v2 provider configuration and well-known manifest (inbound adapters).", dependencies: ["@inference-router/core"] },
  {
    dir: "apps/router",
    name: "@inference-router/router",
    description: "The inference-router daemon and CLI (application services, HTTP/CLI adapters, composition root).",
    dependencies: [
      "@inference-router/core",
      "@inference-router/provider-claude",
      "@inference-router/provider-antigravity",
      "@inference-router/provider-openai",
      "@inference-router/provider-gateway",
      "@inference-router/provider-openrouter",
      "@inference-router/provider-opencode",
      "@inference-router/provider-cheaper-inference",
      "@inference-router/dialect-anthropic",
      "@inference-router/dialect-openai",
      "@inference-router/dialect-gemini",
      "@inference-router/dialect-opencode",
    ],
  },
];

for (const pkg of packages) {
  const dir = join(root, pkg.dir);
  for (const tier of ["unit", "component", "live", "e2e"]) {
    mkdirSync(join(dir, "tests", tier), { recursive: true });
    // A tier directory holds a .gitkeep only while it has nothing else (git does not track empty directories).
    const keep = join(dir, "tests", tier, ".gitkeep");
    if (!existsSync(keep) && readdirSync(join(dir, "tests", tier)).length === 0) writeFileSync(keep, "");
  }
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    const current = JSON.parse(readFileSync(manifest, "utf8")) as { exports?: Record<string, string> };
    if (current.exports?.["./*"] === "./src/*.ts") {
      current.exports = { "./*": "./src/*" };
      writeFileSync(manifest, JSON.stringify(current, null, 2) + "\n");
      console.log(`fixed exports of ${pkg.dir}`);
    }
    continue;
  }
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: pkg.name,
        version: "0.1.0",
        private: true,
        license: "MIT",
        type: "module",
        description: pkg.description,
        // Specifiers carry the .ts extension (`@inference-router/core/domain/wire.ts`), so the pattern must not add one.
        exports: { "./*": "./src/*" },
        dependencies: Object.fromEntries(pkg.dependencies.map((name) => [name, "workspace:*"])),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`scaffolded ${pkg.dir}`);
}
