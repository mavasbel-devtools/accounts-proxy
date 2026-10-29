# Plan 2026-10-28-13-40: cached model lists, fetched once at start

Extends [plan 2026-10-26 (model-list age and refresh, R1–R2)](2026-10-26-08-06-model-list-refresh-plan.md); nothing in
it is replaced. Approved by the user on 2026-10-28 with two answers: a list older than `modelListMaxAgeMinutes` is
fetched again in the background ("Also when older than the max age"), and a failed fetch keeps the saved copy and is
retried later ("Saved copy, retry later (Recommended)").

## Why

The daemon's log of 2026-10-28 (`.cache/logs/2026-10-28-123936-usage.jsonl`) showed:

| Observation | Count |
|---|---|
| Antigravity `fetchAvailableModels` calls in about 2 hours (one per opencode config request, 23 at the same moment at 17:15:55Z) | 55 |
| `/opencode/config.json` answers without `ap-antigravity` (live fetch failed after a suspend: `getaddrinfo ETIMEOUT daily-cloudcode-pa.googleapis.com`; no copy to fall back on) | 31 of 83 |
| Upstream model-list calls by every other provider and the reference catalog (served from the stored copy) | 0 |

Only Antigravity logged its fetches.

## Changes

| # | Change | Where |
|---|---|---|
| M1 | Antigravity keeps its model list like every other provider: in memory and stored (`state/antigravity/model-catalog.json`, the signed-in account's id with it). Concurrent reads share one fetch. A failed fetch answers the kept list (source `cache`) with a WARN instead of dropping the provider. | `packages/provider-antigravity/src/adapters/outbound/antigravity-catalog.ts` (`AntigravityModelList`, `AntigravityCatalog`) |
| M2 | `serve` fetches every enabled provider's list and the reference catalog once, in parallel, when it starts, and answers requests without waiting for them (`WarmModelsPort`, `WarmModelsService`). | `apps/proxy/src/application/warm-models-service.ts`, `apps/proxy/src/composition/container.ts` |
| M3 | A read of a list older than `modelListMaxAgeMinutes` answers the kept list at once and starts a fetch in the background (reason `stale`). | `packages/core/src/ports/outbound/model-list-cache.ts` (`ModelListCacheBase`) |
| M4 | After a failed fetch, the first read at least `MODEL_LIST_RETRY_MS` (60000 ms) later fetches again in the background (reason `retry`), until one succeeds. | `packages/core/src/domain/model-list.ts`, `ModelListCacheBase` |
| M5 | Every fetch logs one INFO line when it starts and one line when it ends, for all seven providers and the reference catalog: `<label>: model list <reason>: fetching`, then `→ live: <n> models (<ms> ms)` or WARN `→ failed after <ms> ms (<error>) → <the list fetched / the saved copy fetched> <time>: <n> models` (or `→ the built-in list`, or `→ no list`). A stored copy loaded at first use logs `model list loaded from the saved copy fetched <time>: <n> models`. Answers from memory log nothing. Reasons: `start`, `first use`, `stale`, `retry`, `refresh`, `unknown model`, `account changed`. | `ModelListCacheBase` |
| M6 | A request for an Antigravity model the kept list lacks fetches once more through the shared fetch (reason `unknown model`); a kept list of another account is fetched again (reason `account changed`). | `AntigravityCatalog` |
| M7 | Tests (unit, component, e2e) and docs in step; `bun run verify`. | below |
| M8 | Live check on the user's daemon (127.0.0.1:4141), then commit and push. | below |

Claude (`ClaudeModelList`), the gateways (`GatewayModelList`) and the reference catalog (`ModelReferenceCatalog`) move
onto the same base, so the rules above hold for every list. The stored-copy key and file of each list are unchanged.

## Execution record

| Step | State | Evidence |
|---|---|---|
| M1–M6 | done | code above |
| M7 tests | done | `packages/core/tests/unit/model-list-cache.test.ts`; component tests of the Claude, Antigravity, gateway and reference catalogs; e2e `model-catalog.test.ts` ("a daemon's kept lists …": built-in and fetched list kept on a failed refresh, background `retry` and `stale` after 61 s), `antigravity-edges.test.ts`, `sessions.test.ts`, `gateways.test.ts`, `openai.test.ts`, `claude-edges.test.ts` |
| M7 gate | done | `bun run verify` 2026-10-28: `GATE: PASS` (typecheck, unit+component+arch 100%, build, e2e 100%, merged 100%, recon parity, docs lint) |
| M7 docs | done | AGENTS.md (model details), [API reference](../reference/2026-10-17-19-26-proxy-api.md) §2, §7, §10, [providers](../reference/2026-10-17-19-26-providers.md) model-list rows, `docs/architecture.drawio` |
| M8 (a) | done | daemon restarted 2026-10-29 16:38:09Z (pid 979093): one `start: fetching` line per enabled provider and the reference catalog, each `→ live` (openrouter 457, claude 12, reference 653, opencode-go 37, opencode 130, antigravity 21, cheaper-inference 350; 108–858 ms) |
| M8 (b) | done | 11 `/opencode/config.json` requests in that daemon's usage log; each model-list URL (`fetchAvailableModels`, `openrouter.ai/api/v1/models`, `api.cheaperinference.com/v1/models`, `models.opencode.ai/api.json`, Claude `model_selector/cc`) requested exactly once upstream, the start-up fetch |
| M8 push | done | `9513f7f` pushed to `origin/main` 2026-10-29 after a secret audit of the pushed diff: 57 values from the real accounts, token, OpenCode auth, provider id and backup files, 0 found; 0 matches for emails, API-key/token/JWT/UUID patterns, user names, home paths, private keys |
| M8 (c) | pending | a daemon started with the network down still lists `ap-antigravity`, from the saved copy; needs the operator's offline restart |
