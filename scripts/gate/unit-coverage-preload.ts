// `bun test --preload` hook for the unit/component coverage run: instruments sources, then writes the raw
// istanbul map to $INFERENCE_ROUTER_UNIT_COVERAGE_FILE once every test file has finished.
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerInstrumentation } from "./instrument.ts";

registerInstrumentation("istanbul-unit-coverage");

afterAll(() => {
  const output = process.env.INFERENCE_ROUTER_UNIT_COVERAGE_FILE;
  if (!output) return;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(globalThis.__coverage__ ?? {}));
});
