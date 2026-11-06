// The `opencode` executable dependency of `cost --reconcile` (plan 2026-11-06-15-21, uc-4), live: the real binary on
// this machine, its own JSON shape. Runs only with ACCOUNTS_PROXY_LIVE=1, like every live suite.
import { describe, expect, test } from "bun:test";

const live = process.env.ACCOUNTS_PROXY_LIVE === "1";

describe("opencode stats --cost --json (live)", () => {
  test.skipIf(!live)("uc-4: answers a finite cost the reconciliation can read", async () => {
    const child = Bun.spawn(["opencode", "stats", "--days", "1", "--cost", "--json"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const text = await new Response(child.stdout).text();
      const code = await child.exited;
      expect(code).toBe(0);
      const parsed = JSON.parse(text) as { cost?: unknown };
      expect(typeof parsed.cost).toBe("number");
      expect(Number.isFinite(parsed.cost as number)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 90_000);
});
