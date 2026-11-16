// One-shot P1 scaffold: writes each workspace package's package.json and its tests/{unit,component,live,e2e}
// skeleton. Idempotent: an existing package.json is left untouched, so it is safe to re-run.
// Only the layered workspaces are listed. tests/support (@accounts-proxy/test-support) and scripts
// (@accounts-proxy/scripts) are hand-maintained workspaces with no layers and no test tiers; a workspace whose
// tests import the shared fakes declares "@accounts-proxy/test-support": "workspace:*" in devDependencies.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const packages: { dir: string; name: string; description: string; dependencies: string[] }[] = [
  { dir: "packages/core", name: "@accounts-proxy/core", description: "Canonical domain model, errors and ports (stdlib only).", dependencies: [] },
  { dir: "packages/provider-claude", name: "@accounts-proxy/provider-claude", description: "Claude subscription provider (outbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/provider-antigravity", name: "@accounts-proxy/provider-antigravity", description: "Google Antigravity provider (outbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/provider-openai", name: "@accounts-proxy/provider-openai", description: "OpenAI provider: Sign in with ChatGPT plan usage (outbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/provider-gateway", name: "@accounts-proxy/provider-gateway", description: "Shared base of the API-key gateway providers (plan P4.6).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/provider-openrouter", name: "@accounts-proxy/provider-openrouter", description: "OpenRouter provider (API-key gateway, PKCE login).", dependencies: ["@accounts-proxy/core", "@accounts-proxy/provider-gateway"] },
  { dir: "packages/provider-opencode", name: "@accounts-proxy/provider-opencode", description: "OpenCode Zen and Go providers (API-key gateways).", dependencies: ["@accounts-proxy/core", "@accounts-proxy/provider-gateway"] },
  { dir: "packages/provider-cheaper-inference", name: "@accounts-proxy/provider-cheaper-inference", description: "Cheaper Inference provider (API-key gateway).", dependencies: ["@accounts-proxy/core", "@accounts-proxy/provider-gateway"] },
  { dir: "packages/dialect-anthropic", name: "@accounts-proxy/dialect-anthropic", description: "Anthropic Messages dialect codec (inbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/dialect-openai", name: "@accounts-proxy/dialect-openai", description: "OpenAI Chat Completions dialect codec (inbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/dialect-gemini", name: "@accounts-proxy/dialect-gemini", description: "Gemini generateContent dialect codec (inbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/dialect-opencode", name: "@accounts-proxy/dialect-opencode", description: "opencode v2 provider configuration and well-known manifest (inbound adapters).", dependencies: ["@accounts-proxy/core"] },
  { dir: "packages/dialect-pi", name: "@accounts-proxy/dialect-pi", description: "pi models.json configuration and well-known manifest (inbound adapters).", dependencies: ["@accounts-proxy/core"] },
  {
    dir: "apps/proxy",
    name: "@accounts-proxy/proxy",
    description: "The accounts-proxy daemon and CLI (application services, HTTP/CLI adapters, composition root).",
    dependencies: [
      "@accounts-proxy/core",
      "@accounts-proxy/provider-claude",
      "@accounts-proxy/provider-antigravity",
      "@accounts-proxy/provider-openai",
      "@accounts-proxy/provider-gateway",
      "@accounts-proxy/provider-openrouter",
      "@accounts-proxy/provider-opencode",
      "@accounts-proxy/provider-cheaper-inference",
      "@accounts-proxy/dialect-anthropic",
      "@accounts-proxy/dialect-openai",
      "@accounts-proxy/dialect-gemini",
      "@accounts-proxy/dialect-opencode",
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
        // Specifiers carry the .ts extension (`@accounts-proxy/core/domain/wire.ts`), so the pattern must not add one.
        exports: { "./*": "./src/*" },
        dependencies: Object.fromEntries(pkg.dependencies.map((name) => [name, "workspace:*"])),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`scaffolded ${pkg.dir}`);
}
