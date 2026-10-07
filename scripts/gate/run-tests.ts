// Test-tier runner. Usage: bun scripts/gate/run-tests.ts <unit|coverage|e2e|live>
//   unit     — tests/arch, tests/support and every workspace's tests/unit + tests/component
//   coverage — the same set under istanbul instrumentation, then the 100% + completeness gate
//   e2e      — every workspace's tests/e2e (daemons inherit INFERENCE_ROUTER_E2E_COVERAGE_DIR), then the gate
//   live     — every workspace's tests/live with INFERENCE_ROUTER_LIVE=1 (real accounts; never part of verify)
// Options: --workspace <packages/x|apps/x> scopes unit/coverage to one workspace (development aid, not the gate).
// Exit codes: 0 pass, 1 fail, 3 incomplete (the tier has no test files yet — reported, never treated as a pass).
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadMaps, report, scopeMap } from "@inference-router/scripts/gate/coverage-report.ts";
import { repositoryRoot } from "@inference-router/scripts/gate/instrument.ts";

export const INCOMPLETE = 3;

function containsTests(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? containsTests(full) : entry.endsWith(".test.ts");
  });
}

export function tierDirectories(tiers: readonly string[], includeRoot: boolean): string[] {
  const dirs = includeRoot ? [join(repositoryRoot, "tests", "arch"), join(repositoryRoot, "tests", "support")] : [];
  for (const group of ["packages", "apps"]) {
    const base = join(repositoryRoot, group);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base)) for (const tier of tiers) dirs.push(join(base, workspace, "tests", tier));
  }
  return dirs.filter(containsTests);
}

async function bunTest(args: string[], env: Record<string, string>): Promise<number> {
  const child = Bun.spawn([process.execPath, "test", ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function gate(files: string[], outputDirectory: string, label: string): number {
  const failures = report(loadMaps(files), outputDirectory, label);
  for (const failure of failures) console.error(`COVERAGE GATE FAIL — ${failure}`);
  if (failures.length === 0) console.log(`${label}: coverage gate PASS (100% lines/statements/functions/branches, complete)`);
  return failures.length === 0 ? 0 : 1;
}

async function main(mode: string | undefined, workspace: string | undefined): Promise<number> {
  const coverageRoot = join(repositoryRoot, "coverage");
  const scoped = (tiers: string[]) =>
    workspace === undefined
      ? tierDirectories(tiers, true)
      : tiers.map((t) => join(repositoryRoot, workspace, "tests", t)).filter(containsTests);
  if (mode === "unit") return bunTest(scoped(["unit", "component"]), {});
  if (mode === "coverage") {
    // A --workspace run is a development aid scoped to one workspace's sources; only the unscoped run is the gate.
    const outDir = workspace === undefined ? join(coverageRoot, "unit") : join(coverageRoot, "scoped", workspace.replaceAll("/", "-"));
    const raw = join(outDir, "raw.json");
    rmSync(outDir, { recursive: true, force: true });
    const code = await bunTest(["--preload", join(import.meta.dir, "unit-coverage-preload.ts"), ...scoped(["unit", "component"])], {
      INFERENCE_ROUTER_UNIT_COVERAGE_FILE: raw,
    });
    if (code !== 0) return code;
    if (!existsSync(raw)) {
      console.error("COVERAGE GATE FAIL — unit raw coverage file was not written");
      return 1;
    }
    if (workspace === undefined) return gate([raw], outDir, "unit");
    const failures = report(scopeMap(loadMaps([raw]), workspace), outDir, `unit[${workspace}]`, workspace);
    for (const failure of failures) console.error(`COVERAGE GATE FAIL — ${failure}`);
    if (failures.length === 0) console.log(`unit[${workspace}]: scoped coverage PASS (100%, complete)`);
    return failures.length === 0 ? 0 : 1;
  }
  if (mode === "e2e") {
    const dirs = tierDirectories(["e2e"], false);
    if (dirs.length === 0) {
      console.error("E2E INCOMPLETE — no e2e test files exist yet");
      return INCOMPLETE;
    }
    const rawDir = join(coverageRoot, "e2e", "raw");
    rmSync(join(coverageRoot, "e2e"), { recursive: true, force: true });
    const code = await bunTest(dirs, { INFERENCE_ROUTER_E2E_COVERAGE_DIR: rawDir });
    if (code !== 0) return code;
    const files = existsSync(rawDir) ? readdirSync(rawDir).map((f) => join(rawDir, f)) : [];
    if (files.length === 0) {
      console.error("COVERAGE GATE FAIL — e2e daemons wrote no coverage files");
      return 1;
    }
    return gate(files, join(coverageRoot, "e2e"), "e2e");
  }
  if (mode === "live") {
    const dirs = tierDirectories(["live"], false);
    if (dirs.length === 0) {
      console.error("LIVE INCOMPLETE — no live test files exist yet");
      return INCOMPLETE;
    }
    return bunTest(dirs, { INFERENCE_ROUTER_LIVE: "1" });
  }
  console.error("usage: run-tests.ts <unit|coverage|e2e|live>");
  return 2;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--workspace");
  process.exit(await main(process.argv[2], at > 0 ? process.argv[at + 1] : undefined));
}
