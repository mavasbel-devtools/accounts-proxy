// Coverage reporting and the 100% gate. Two independent checks, both fatal:
//  1. every metric (lines, statements, functions, branches) of the merged map is exactly 100%;
//  2. completeness: every workspace source file that contains runtime code appears in the map. A file no test
//     ever loads is otherwise invisible to istanbul and would silently inflate the percentages.
//     Type-only files (interfaces/types, erased by the transpiler) carry no runtime code and are exempt.
import { createCoverageMap, type CoverageMap, type CoverageMapData } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repositoryRoot } from "./instrument.ts";

const METRICS = ["lines", "statements", "functions", "branches"] as const;

export function loadMaps(files: readonly string[]): CoverageMap {
  const map = createCoverageMap({});
  for (const file of files) map.merge(JSON.parse(readFileSync(file, "utf8")) as CoverageMapData);
  return map;
}

/** Restrict a map to one workspace (`packages/<name>` or `apps/<name>`), for scoped development runs. */
export function scopeMap(map: CoverageMap, workspace: string): CoverageMap {
  const prefix = key(join(repositoryRoot, workspace, "src")) + "\\";
  const unix = prefix.replaceAll("\\", "/");
  map.filter((file) => key(file).startsWith(prefix) || key(file).startsWith(unix));
  return map;
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) found.push(full);
    }
  };
  for (const group of ["packages", "apps"]) {
    const base = join(repositoryRoot, group);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base)) walk(join(base, workspace, "src"));
  }
  return found;
}

export function hasRuntimeCode(source: string): boolean {
  const output = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  return output.replace(/export\s*\{\s*\};?/g, "").trim() !== "";
}

const key = (path: string): string => resolve(path).toLowerCase();

export function missingRuntimeSources(map: CoverageMap, workspace?: string): string[] {
  const covered = new Set(map.files().map(key));
  const scope = workspace === undefined ? undefined : key(join(repositoryRoot, workspace, "src"));
  return sourceFiles().filter(
    (file) =>
      (scope === undefined || key(file).startsWith(scope)) && !covered.has(key(file)) && hasRuntimeCode(readFileSync(file, "utf8")),
  );
}

export function report(map: CoverageMap, outputDirectory: string, label: string, workspace?: string): string[] {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "coverage-final.json"), JSON.stringify(map.toJSON()));
  const context = createContext({ dir: outputDirectory, coverageMap: map });
  for (const kind of ["text", "text-summary", "lcovonly", "json-summary"] as const) reports.create(kind).execute(context);
  const failures: string[] = [];
  if (map.files().length === 0) failures.push(`${label}: coverage map is empty`);
  const summary = map.getCoverageSummary().toJSON();
  for (const metric of METRICS) {
    if (summary[metric].pct !== 100) failures.push(`${label}: ${metric} ${summary[metric].covered}/${summary[metric].total} (${summary[metric].pct}%)`);
  }
  for (const file of missingRuntimeSources(map, workspace)) failures.push(`${label}: never loaded by any test: ${file}`);
  return failures;
}
