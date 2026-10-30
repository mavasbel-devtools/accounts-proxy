// The documentation gate must exclude the proxy's mutable .cache/ home: recon clients can remove their temporary files
// while it runs, and neither runtime data nor captures are documentation inputs.
import { expect, test } from "bun:test";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";

test("documentation lint ignores the mutable cache tree", () => {
  const lint = Bun.spawnSync([process.execPath, "scripts/gate/lint-docs.ts"], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  expect(lint.exitCode).toBe(0);
  expect(lint.stdout.toString()).toContain("docs lint PASS");
  expect(lint.stderr.toString()).toBe("");
});
