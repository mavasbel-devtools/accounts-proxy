# Antigravity: advertise the real context window

## Why

Every Antigravity model is advertised with `limit.context: 80000` although the provider's catalog states its real
window (1,048,576 for Gemini 3.8 Flash). Under Magic Context this makes long OpenCode sessions refuse their turn after
60 s, before any request reaches the proxy. Evidence and cause:
[issue 2026-11-02-21-29](../issues/2026-11-02-21-29-antigravity-80k-window-refusals.md).

## What

- W1. `limit.context` and `limit.output` of an Antigravity model are the catalog's `maxTokens` and `maxOutputTokens`,
  verbatim. A limit is still advertised only when both are positive (limit law 4, unchanged).
- W2. The parity reference follows the plugin version that made the same change: opencode-antigravity-auth
  `ba0ae60` (2026-10-16), byte-identical, replacing `plugin-5c6f7c2`.
- W3. Tests pin W1 at every tier: unit, component, parity and e2e (`GET /opencode/config.json`).
- W4. Every document that states the 80k window is brought in step; the model reference is regenerated.

Out of scope: the user's Magic Context configuration (handled by the user in another session); the
`opencode/deepseek-v4.1-flash-free` refusals (a different case).

## How

| Step | Change | Verified by |
|---|---|---|
| S1 | Remove `IDE_WORKING_SET_CONTEXT_CAP` (`packages/provider-antigravity/src/domain/constants.ts`) and `advertisedContextWindow` (`.../domain/catalog.ts`); `advertisedLimits` returns `{ context: maxTokens, output: maxOutputTokens }` | unit `domain.test.ts` |
| S2 | Re-vendor the parity reference with `scripts/evidence/vendor-reference.ts` at `ba0ae60` into `tests/reference/plugin-ba0ae60/`; delete `plugin-5c6f7c2/`; adapt `parity.test.ts` (the plugin's `supportedMimeTypes` vs the proxy's `mimeTypes`); update `PROVENANCE.md` | 0 blob mismatches; parity tests pass |
| S3 | Update the tests that expect 80000 (unit, component, e2e) to the catalog values; add an e2e assertion on `/opencode/config.json` | `bun run verify` |
| S4 | Regenerate `docs/reference/2026-10-17-19-26-models.md` (`bun scripts/docs/models-reference.ts`); bring README, AGENTS.md and the session record in step | docs-in-step test, docs lint |
| S5 | Full gate `bun run verify` with 100% coverage on every tier; secret audit of the diff; commit and push to `main` | gate output, commit hash |
| S6 | Restart the proxy; `GET /opencode/config.json` shows `limit.context: 1048576` for `gemini-3.8-flash-medium` | live read |

## Acceptance

- No source file under `packages/*/src` or `apps/*/src` contains `IDE_WORKING_SET_CONTEXT_CAP` or caps a window at 80000.
- The reference `MANIFEST.json` records commit `ba0ae60db52b5318e52f04a662a2cccaf65bd114` with every blob equal.
- `bun run verify` passes; the live config lists the catalog window for every Antigravity model.
