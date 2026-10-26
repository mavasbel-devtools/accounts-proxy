# Model-list age and refresh (plan 2026-10-26)

Extends [plan v4](2026-10-11-22-11-completion-plan.md) and the
[model catalog and docs plan](2026-10-16-00-08-model-catalog-docs-plan.md); nothing in them is replaced.

## Request

User, 2026-10-26: "can we make it configurable and refresh?" — the age after which a fetched model list is read again
was a fixed 24 h in three places, and nothing could force a new read short of deleting the stored copies.

## Measured starting state (commit c473f1b)

| Cache | Where | Fixed age |
|---|---|---|
| Claude model list | `packages/provider-claude/src/domain/constants.ts` `CATALOG.ttlMs` | 24 h |
| Gateway model lists (OpenRouter, Cheaper Inference) | `packages/provider-gateway/src/domain/gateway.ts` `CATALOG_TTL_MS` | 24 h |
| Reference catalog models.opencode.ai (OpenCode, OpenCode Go, OpenAI ids, details) | `apps/proxy/src/adapters/outbound/model-reference-catalog.ts` `REFERENCE_TTL_MS` | 24 h |
| Antigravity | `fetchAvailableModels` on every use, memoized per process | none |

opencode itself re-reads the proxy's configuration every 10 minutes, so a list the proxy re-reads reaches opencode within
10 minutes.

## Decisions

| Id | Decision |
|---|---|
| R1 | `proxy.yaml` key `modelListMaxAgeMinutes` (positive integer, default 1440 = 24 h) replaces the three fixed ages; one value for every cache (`modelListMaxAgeMs` in `packages/core/src/domain/config.ts`). Validated strictly like every other key. |
| R2 | `POST /proxy/v1/models/refresh` (`?provider=<id>`, proxy token) reads every enabled provider's list (or the named one) and, when one of them takes details from it, the reference catalog now, then answers `GET /proxy/v1/models`'s shape. Fallbacks are unchanged: a failed read keeps the stored copy, then the built-in list. `ProviderPort.refreshModels()` defaults to `models()` (Antigravity reads on every use; OpenAI takes its ids from the reference catalog); Claude and the gateways override it. |
| R2 | `models [<provider>] [--refresh]` asks the running daemon on the configured port (`RequestModelRefreshService`, deadline `REFRESH_TIMEOUT_MS` 300000 ms) so its memory and the opencode configuration change at once; when nothing listens there, the command refreshes in its own process and rewrites the stored copies a daemon reads at start. The output names which one refreshed. |
| R3 | The API reference, OpenAPI document, providers reference, example configuration and the docs tests (`docs-in-step`, e2e `docs.test.ts`) state R1 and R2. |

## Out of scope (law)

The daemon keeps binding `127.0.0.1` only ([AGENTS.md](../../AGENTS.md) §4 Local access). Another machine reaches it
through a tunnel the operator opens (for example `ssh -N -L 4141:127.0.0.1:4141 <user>@<this-host>`), never by
binding another address.

## Verification

`bun run verify` (typecheck, unit+component+arch 100%, build, e2e 100%, merged 100%, docs lint); the result is recorded
under "Execution record" below.

## Execution record

| Step | Result |
|---|---|
| R1–R3 implemented | `RefreshModelsService`, `RequestModelRefreshService`, `ProviderPort.refreshModels()`, the route, the `--refresh` option and the documents above |
| e2e `model-catalog.test.ts` "model-list age and refresh" | without a daemon (refresh in this process, a stored copy reused within the age, a provider without a reference provider leaves the reference catalog unread, a named provider's error, a defect never hidden); with a daemon (refresh by the daemon, its HTTP error reported); something else on the port (HTTP 500, an answer without catalogs), an unreadable proxy token, an invalid `modelListMaxAgeMinutes` |
| `bun run verify` 2026-10-26 | `GATE: PASS` (exit 0): 912 unit+component+arch tests and 260 e2e tests, 0 failures; unit+component+arch, e2e and merged coverage 100%; docs lint pass. An earlier run had one timeout in `container.test.ts` under host load; the file alone passed 20/20 and the full rerun passed |
| Live check, isolated daemon (`ACCOUNTS_PROXY_HOME` in `/tmp/opencode`, port 4199, `modelListMaxAgeMinutes: 5`, openrouter + opencode + cheaper-inference without accounts) | no daemon: `refreshed by this process`, openrouter 466 / opencode 130 / cheaper-inference 258 models from the live catalogs, stored copies written; with the daemon: `refreshed by the daemon at http://127.0.0.1:4199`, `--json` `refreshedBy: daemon`; `POST /proxy/v1/models/refresh?provider=cheaper-inference` 200, `?provider=claude` 503 `provider_disabled`, `?provider=nope` 400 `invalid_request`; SIGTERM exit 0. The real account files and `token.json` were unchanged (hash before = after); the user's daemon (`accounts-proxy.service`) was not touched |
