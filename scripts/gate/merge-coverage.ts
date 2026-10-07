// Merged (unit ∪ e2e) coverage gate. Both inputs must exist; a missing input is a failure, never skipped.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadMaps, report } from "@inference-router/scripts/gate/coverage-report.ts";
import { repositoryRoot } from "@inference-router/scripts/gate/instrument.ts";
import { INCOMPLETE, tierDirectories } from "@inference-router/scripts/gate/run-tests.ts";

const inputs = [
  join(repositoryRoot, "coverage", "unit", "coverage-final.json"),
  join(repositoryRoot, "coverage", "e2e", "coverage-final.json"),
];
const missing = inputs.filter((file) => !existsSync(file));
if (missing.length === 1 && missing[0] === inputs[1] && tierDirectories(["e2e"], false).length === 0) {
  console.error("MERGED INCOMPLETE — no e2e tier exists yet, so there is nothing to merge");
  process.exit(INCOMPLETE);
}
if (missing.length > 0) {
  for (const file of missing) console.error(`COVERAGE GATE FAIL — merged: missing input ${file}`);
  process.exit(1);
}
const failures = report(loadMaps(inputs), join(repositoryRoot, "coverage", "merged"), "merged");
for (const failure of failures) console.error(`COVERAGE GATE FAIL — ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
