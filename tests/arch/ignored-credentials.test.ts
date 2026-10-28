// The accounts file holds every provider's credentials (plan docs/plans/2026-10-26-23-32-accounts-file-plan.md A4):
// `.cache/` — the file, its temp files and its locks — is ignored by git, so no credential can ever be committed.
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");

test("git ignores the accounts file, its temp files and its locks", () => {
  const paths = [".cache/accounts.json", ".cache/accounts.json.1234.tmp", ".cache/locks/accounts.lock", ".cache/locks/claude-renewal.lock"];
  const check = Bun.spawnSync(["git", "check-ignore", "--no-index", ...paths], { cwd: root });
  expect([check.exitCode, check.stdout.toString().trim().split("\n")]).toEqual([0, paths]);
});
