// The release gate: every step runs in order, each result is reported, and the gate is green only when
// every step passes. A step that cannot run yet (no e2e tests, no daemon entry point) is INCOMPLETE —
// reported explicitly and never counted as a pass.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";

const PASS = 0;
const INCOMPLETE = 3;
const entry = join(repositoryRoot, "apps", "proxy", "src", "main", "cli.ts");

type Step = { name: string; command: string[] | (() => string[] | "incomplete") };

const bun = process.execPath;
const steps: Step[] = [
  { name: "typecheck", command: [bun, "x", "tsc", "--noEmit", "-p", "tsconfig.json"] },
  { name: "unit+component+arch with 100% coverage", command: [bun, "scripts/gate/run-tests.ts", "coverage"] },
  {
    name: "build",
    command: () =>
      existsSync(entry)
        ? [bun, "build", entry, "--target", "bun", "--outfile", join("dist", "accounts-proxy.js")]
        : "incomplete",
  },
  { name: "e2e with 100% coverage", command: [bun, "scripts/gate/run-tests.ts", "e2e"] },
  { name: "merged coverage 100%", command: [bun, "scripts/gate/merge-coverage.ts"] },
  { name: "recon parity (Claude Code 2.1.304)", command: [bun, "scripts/recon/cli.ts", "parity", "tests/fixtures/captures/recon-parity/claude-2.1.304", "18"] },
  { name: "docs lint", command: [bun, "scripts/gate/lint-docs.ts"] },
];

const results: { name: string; outcome: "PASS" | "FAIL" | "INCOMPLETE" }[] = [];
for (const step of steps) {
  const command = typeof step.command === "function" ? step.command() : step.command;
  if (command === "incomplete") {
    results.push({ name: step.name, outcome: "INCOMPLETE" });
    continue;
  }
  console.log(`\n=== verify: ${step.name} ===`);
  const code = await Bun.spawn(command, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" }).exited;
  results.push({ name: step.name, outcome: code === PASS ? "PASS" : code === INCOMPLETE ? "INCOMPLETE" : "FAIL" });
}

console.log("\n=== verify summary ===");
for (const r of results) console.log(`${r.outcome.padEnd(10)} ${r.name}`);
const failed = results.some((r) => r.outcome === "FAIL");
const incomplete = results.some((r) => r.outcome === "INCOMPLETE");
console.log(failed ? "GATE: FAIL" : incomplete ? "GATE: INCOMPLETE (not releasable)" : "GATE: PASS");
process.exit(failed ? 1 : incomplete ? INCOMPLETE : PASS);
