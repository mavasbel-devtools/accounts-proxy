// One-shot P1 scaffold: writes each workspace package's package.json and its tests/{unit,component,live,e2e}
// skeleton. Idempotent: an existing package.json is left untouched, so it is safe to re-run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const packages: { dir: string; name: string; description: string; dependencies: string[] }[] = [
  { dir: "packages/core", name: "@inference-router/core", description: "Canonical domain model, errors and ports (stdlib only).", dependencies: [] },
  { dir: "packages/provider-claude", name: "@inference-router/provider-claude", description: "Claude subscription provider (outbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/provider-antigravity", name: "@inference-router/provider-antigravity", description: "Google Antigravity provider (outbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-anthropic", name: "@inference-router/dialect-anthropic", description: "Anthropic Messages dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-openai", name: "@inference-router/dialect-openai", description: "OpenAI Chat Completions dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  { dir: "packages/dialect-gemini", name: "@inference-router/dialect-gemini", description: "Gemini generateContent dialect codec (inbound adapters).", dependencies: ["@inference-router/core"] },
  {
    dir: "apps/router",
    name: "@inference-router/router",
    description: "The inference-router daemon and CLI (application services, HTTP/CLI adapters, composition root).",
    dependencies: [
      "@inference-router/core",
      "@inference-router/provider-claude",
      "@inference-router/provider-antigravity",
      "@inference-router/dialect-anthropic",
      "@inference-router/dialect-openai",
      "@inference-router/dialect-gemini",
    ],
  },
];

for (const pkg of packages) {
  const dir = join(root, pkg.dir);
  for (const tier of ["unit", "component", "live", "e2e"]) {
    mkdirSync(join(dir, "tests", tier), { recursive: true });
    const keep = join(dir, "tests", tier, ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, "");
  }
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) continue;
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
        exports: { "./*": "./src/*.ts" },
        dependencies: Object.fromEntries(pkg.dependencies.map((name) => [name, "workspace:*"])),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`scaffolded ${pkg.dir}`);
}
