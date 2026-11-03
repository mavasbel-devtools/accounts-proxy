# Antigravity turns refused after 60 s: the advertised 80k window

## Why this record exists

Turns sent to `ap-antigravity/*` models in OpenCode stop after about 60 seconds. No request reaches the proxy and no
answer appears. Earlier explanations (an unstable OpenCode scheduler, corrupted session history, a missing
`capabilities.tools`) were wrong. This record states the observed cause.

## What happens

1. The proxy advertises `limit.context: 80000` for every Antigravity model.
2. Magic Context, the context manager in OpenCode, keeps an output reserve and so works with a 60,000-token window.
3. A session already larger than that window arms overflow recovery. Magic Context then blocks the turn until its
   historian summarises the history.
4. The historian (a local model) does not finish within 60 s. Magic Context refuses the turn before the provider
   request is made.

## Evidence

Magic Context log of the shared OpenCode server: `/tmp/opencode2/magic-context/magic-context.log` (the file under
`/tmp/opencode/` holds only the TUI's lines). Session `ses_ea4a3851affebQO4h3E52qI34j`, 2026-11-03 UTC:

| Time | Log line (abridged) |
|---|---|
| 01:10:06.350 | `last input 73300 ... exceeds new model ap-antigravity/gemini-3.8-flash-medium catalog limit 60000; arming overflow recovery` |
| 01:10:06.385 | `blocking at 95.0% until compartment agent completes` |
| 01:11:06.386 | `compartment await timed out after 60000ms` |
| 01:11:06.618 | `historian did not complete within 60 s ... finalEstimate=60970 estimateTrusted=false contextLimit=60000` |
| 01:11:06.619 | `v2 refusal: interrupting the turn before the provider request` |
| 01:12:34.116 | same session on the plugin's `antigravity/gemini-3.8-flash-medium`: `fits context limit 983040`, the turn runs |

- The proxy usage logs for 01:09:50–01:12:40 (`.cache/logs/2026-11-03-1860490-usage.{10,11}.jsonl`) contain no
  Antigravity request, only `/opencode/config.json` reads and Claude traffic.
- Since 2026-10-29 the log holds 23 refusals: 21 are `ap-antigravity/*` with `contextLimit=60000`; 2 are
  `opencode/deepseek-v4.1-flash-free` (a different case, not covered here).

## Where the 80k comes from

- `packages/provider-antigravity/src/domain/constants.ts:34` `IDE_WORKING_SET_CONTEXT_CAP = 80_000`.
- `packages/provider-antigravity/src/domain/catalog.ts:61-63` `advertisedContextWindow` = `min(maxTokens, 80000)`,
  used by `advertisedLimits` (`catalog.ts:128-130`).
- The live catalog (`.cache/state/antigravity/model-catalog.json`) gives `maxTokens: 1048576` for `gemini-3.8-flash-*`.
- The cap was ported from opencode-antigravity-auth `5c6f7c2` (2026-10-05). The plugin removed it in `ba0ae60`
  (2026-10-16, "advertise real catalog windows") for this same failure: 110 emergency drops and 2 refused turns
  (`EmergencyFailClosedError: historian did not complete within 60 s`), recorded in the plugin's
  `docs/plans/2026-10-16-16-41-real-model-limits-and-attachments.md`. Since `ba0ae60` the plugin's
  `ResolveModelsUseCase.ts:65-70` advertises `{ context: maxTokens, output: maxOutputTokens }`.
- The cap also contradicts this project's model-details rule: a model's fields come from its provider's own list first
  (AGENTS.md §4, rules M1–M6).

## Resolution

Plan [2026-11-02-21-29-antigravity-real-context-window-plan.md](../plans/2026-11-02-21-29-antigravity-real-context-window-plan.md).
