// `bun --preload` hook for daemon processes started by e2e tests: instruments sources and, on process exit,
// writes this process's raw istanbul map to $ACCOUNTS_PROXY_E2E_COVERAGE_DIR/coverage-<pid>.json.
// The daemon must therefore terminate through a normal exit path (never a hard kill) for coverage to count.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerInstrumentation } from "@accounts-proxy/scripts/gate/instrument.ts";

registerInstrumentation("istanbul-e2e-coverage");

process.on("exit", () => {
  const dir = process.env.ACCOUNTS_PROXY_E2E_COVERAGE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `coverage-${process.pid}.json`), JSON.stringify(globalThis.__coverage__ ?? {}));
});
