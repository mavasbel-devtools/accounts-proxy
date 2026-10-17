# Plan: detailed model catalog, opencode configuration endpoint, full documentation (P5 cancelled)

Extends [the main plan](2026-10-06-00-23-inference-router-plan.md), [the completion plan v4](2026-10-11-22-11-completion-plan.md)
and [the live validation](2026-10-13-01-42-live-validation-plan.md); nothing there is replaced.

## 1. User decisions

- 2026-10-14: instead of translating between formats (P5), document every schema, API and provider in full. D1–D4
  approved as recommended:
  - **D1-A** P5 is cancelled and its translation-only code removed (git history keeps it). A request in a format the
    model does not accept natively keeps answering 400 `unsupported_feature`.
  - **D2** Markdown, an OpenAPI 3.1 document of the router's API, and a check in `verify` that keeps the documentation
    in step with the code.
  - **D3** One dated reference document per topic in `docs/reference/`, kept current in place, linked from the README.
  - **D4** The model reference lists every model, generated from the catalog.
- 2026-10-14 (request) / 2026-10-16 (approval): every provider exposes its models with full detail in a form opencode
  consumes (context window, variants, media, …), built from opencode's own model schema. E1–E6 approved as recommended:
  - **E1** opencode gets the configuration through its well-known login (`opencode auth login http://127.0.0.1:4141`,
    refreshed by opencode) and, as fallback, a static file printed by the CLI. `/.well-known/opencode` is served
    without the router token, like `/health` (it carries no secret); the configuration itself requires the token.
  - **E2** opencode v2 native `providers` schema, pinned to the installed opencode v2.0.26, re-checked against upstream
    before release.
  - **E3** Sources per field: the provider's own live model list first, then models.opencode.ai matched by exact id or
    `canonical_model_id`. A field no source states is left out, never guessed; every field records its source. This
    supersedes N6 for model details.
  - **E4** Cost: gateways report the vendor's price (OpenRouter's list, opencode's own catalog for `opencode` and
    `opencode-go`, Cheaper Inference's list where it states one); subscription providers (`claude`, `antigravity`,
    `openai`) report no cost.
  - **E5** Variants: only variants the router accepts, built with opencode's rules for the connection package, each
    distinct shape proven live.
  - **E6** One opencode provider per router provider, id `ir-<provider>` (name "Inference Router · <Provider>").

## 2. Evidence (opencode v2.0.26, read 2026-10-14)

| Fact | Source |
|---|---|
| opencode's model catalog is `https://models.opencode.ai/api.json` (models.dev format, 229 providers, 8 819 models on 2026-10-14) | `packages/core/src/models-dev.ts:281-346` |
| v2 configuration key `providers`, model fields `capabilities`, `limit`, `variants`, `cost`, `family`, `compatibility`, `package`, `settings`, `headers`, `body` | `packages/schema/src/config/provider.ts` |
| v1 model keys `release_date`, `attachment`, `reasoning`, `temperature`, `experimental` are dropped as unsupported | `packages/core/src/config/normalize.ts:54` |
| `/.well-known/opencode` manifest: `auth {command, env}`, `config`, `remote_config {url, headers}` with `{env:NAME}` substitution | `packages/core/src/wellknown.ts`, `packages/core/script/wellknown-server.ts` |
| Variants per connection package and `reasoning_options` (`effort`, `toggle`, `budget_tokens`) | `packages/core/src/variant.ts` |
| AI SDK package → native protocol mapping | `packages/core/src/aisdk-native.ts` |

## 3. Steps

| # | Step | Status |
|---|---|---|
| C0 | Evidence: the catalog (`api.json`, hash, committed extract for the router's providers), opencode's config JSON Schema, the opencode v2.0.26 sources copied unchanged and pinned, the vendors' richest model-list fields; a rules document citing a source for every field | done 2026-10-16 |
| C1 | Remove P5: the translation-only code and its tests; `scripts/gate/e2e-deferred.ts` ends empty | done 2026-10-16 |
| C2 | Core detailed catalog: one model record (formats, limits, media, tools, reasoning and variants, structured output, temperature, knowledge, release, status, family, cost) with a source per field | done 2026-10-16 |
| C3 | Every provider builds its detailed list (own list → models.opencode.ai) | done 2026-10-16 |
| C4 | Routes `GET /router/v1/models`, `GET /opencode/config.json`, `GET /.well-known/opencode`; CLI `opencode-config` | done 2026-10-16 |
| C5 | Tests at 100% (unit+component, e2e); the generated configuration validated against the pinned JSON Schema | done 2026-10-16 (commit 98f610f) |
| C6 | Live: opencode v2.0.26 well-known login against the daemon (temporary folders only), model list, one request per provider and per distinct variant shape (N9) | done 2026-10-16 (rule O6 added) |
| C7 | Documentation (API, providers, formats, models, clients), OpenAPI 3.1, docs-in-step check, AGENTS.md, README, diagram; `bun run verify`; commit | |

## 4. Execution record
- 2026-10-16 00:08 plan written (decisions of 2026-10-14 and 2026-10-16).
- 2026-10-16 C0 (part): `models-opencode-reference.json` (the six reference providers of `https://models.opencode.ai/api.json`)
  and `opencode-config-schema.json` (`https://opencode.ai/config.json`) fetched with provenance; 15 opencode v2.0.26 files
  (commit 9b4ec5714d) vendored byte-identical into `packages/dialect-opencode/tests/reference/plugin-9b4ec5714d/`
  (0 blob mismatches); new workspace `@inference-router/dialect-opencode`. Reference coverage of the live lists
  (2026-10-16): claude 14/14 exact ids, openai 7/7, openrouter 385/465, opencode 82/86, opencode-go 30/37,
  antigravity 6/24 (google), cheaper-inference has no reference provider.
- 2026-10-16 C1: removed the canonical request model (`core/domain/canonical/*`), FeatureSupport, the usage merger,
  the SSE encoder and end-of-stream check, `ChatPort`/`CountTokensPort`, `ProviderPort.{capabilities,stream,countTokens}`,
  Antigravity's OpenAI-shaped chat path (`AntigravityChat`, `GenerateCodec`, `wireDefaultsFor`) and the E2 capture
  script that used it; the dialects share `errorHeaders`. `E2E_DEFERRED` is empty. `bun run verify`: GATE: PASS
  (656 unit+component, 214 e2e, 100% coverage everywhere, 0 deferrals).
- 2026-10-16 C0 (rest): rules document [2026-10-16-01-38-model-catalog-rules.md](../reference/2026-10-16-01-38-model-catalog-rules.md)
  (M1–M6 detailed record, the fields each provider's own list states, O1–O5 opencode configuration); gateway rules
  amended (Z5 reads models.opencode.ai, G5 cache version 2).
- 2026-10-16 C2–C4: `core/domain/model-details.ts` (DetailedModel, per-field sources, reference parser),
  `ModelReferencePort` + `ModelReferenceCatalog` (live → stored copy 24 h → built-in copy), `DescribeModelsService`;
  provider lists carry their own details (claude capabilities, antigravity MIME types, openai description/modalities/
  reasoning levels, openrouter modalities/parameters/efforts/prices/tiers, cheaper-inference flags/prices/tiers);
  `dialect-opencode` (`OpencodeConfigCodec`, the port of opencode's variant rules, parity-checked against the vendored
  `variant.ts` over every reference model and package); routes and CLI `models --json`, `opencode-config`. A provider
  that cannot list (no account) is `unavailable` in a listing of all providers instead of failing it. The generated
  configuration passes opencode's published schema (`tests/support/json-schema.ts`). Measured live 2026-10-16 with a
  fresh data home without accounts (public lists live; claude and openai built-in; antigravity unavailable): ir-claude
  10 models, ir-openai 16, ir-openrouter 465 (458 priced, 296 with variants), ir-opencode 84, ir-opencode-go 29,
  ir-cheaper-inference 90; 0 schema errors.
- 2026-10-16 C5: e2e `model-catalog.test.ts` drives the daemon routes, the CLI, every fallback of the reference catalog
  and each list shape (rows added to the committed vendor lists); the opencode package type is closed to the five
  packages the router writes, so no unreachable branch remains. `bun run verify`: GATE: PASS (683 unit+component,
  218 e2e, 100% coverage on every tier, 0 deferrals). Commit 98f610f, pushed; GitHub main matches local.
- 2026-10-16 C6 (part 1, no account used): a second daemon at `127.0.0.1:4142` on a fresh data home (no accounts) and
  opencode v2.0.26 with every XDG directory under `/tmp/opencode/c6` (its own service port 49399, since 49374 is the
  user's). `opencode auth login http://127.0.0.1:4142` ran the manifest's token command and stored the source
  ("Connected to 127.0.0.1"); `opencode models` listed ir-claude 10, ir-openai 16, ir-openrouter 465, ir-opencode 84,
  ir-opencode-go 29, ir-cheaper-inference 91 (ir-antigravity left out: no account). opencode's resolved models
  (`GET /api/model`) equal the configuration on every model (695) in package, name, family and variants (1 505
  variants, six shapes); the only differences are opencode's own defaults for fields the configuration leaves out:
  `capabilities.tools: true` and `input: ["text","image"]` (`schema/src/model.ts:98`, `core/src/model.ts:32-38`),
  `limit {context: 200000, output: 32000}` (`schema/src/model.ts:150-163`), `cost: []` and cache prices 0
  (`core/src/config/plugin/provider.ts:137-149`). Both test processes stopped with SIGTERM. Part 2 (requests through
  the user's signed-in daemon on 4141) waits until that daemon runs commit 98f610f: it was started 2026-10-16 00:08
  from a terminal, before C2–C4, and was serving requests.
- 2026-10-16 C6 (part 2, the user's signed-in daemon, restarted by the user on commit 98f610f): opencode v2.0.26 with
  every XDG directory under `/tmp/opencode/c6live` (service port 49398). `opencode auth login http://127.0.0.1:4141`
  stored the source; the first `opencode models` right after the login raced opencode's asynchronous configuration load
  (`config.updated` logged at the same second) and listed no `ir-` provider, the next one listed all seven (ir-claude 14,
  ir-antigravity 24, ir-openai 7, ir-openrouter 467, ir-opencode 84, ir-opencode-go 29, ir-cheaper-inference 91).
  Requests ("Reply with the single word OK.", `opencode run --auto`) through a logging proxy on 4143 (a project
  `opencode.json` pointing the tested models' `baseURL` at it; the proxy recorded only path, status, beta,
  `x-router-dropped` and the fields a variant sets): every provider answered "OK", each variant shape reached the
  router with its setting and the default without it — Anthropic budget (`haiku-4-5#high` → `thinking.enabled
  budget_tokens 16000`), Anthropic adaptive + effort (`haiku-5-5#low` → `output_config.effort low`), Responses
  (`gpt-5.6-luna#low` → `reasoning.effort low`; `max_output_tokens` dropped by the provider's lossy header, F5),
  OpenRouter (`nemotron-3.5-lightning:free#thinking` → `reasoning.enabled`), Gemini (`opencode/gemini-3-flash#minimal`
  → `thinkingLevel minimal`), Chat (`opencode-go/deepseek-v4.1-flash#low` → `reasoning_effort low`), Antigravity and
  Cheaper Inference without variants.
- 2026-10-16 C6 findings → rule O6: (1) every `claude` 5.1+ request from opencode failed 400 `unsupported_feature`:
  opencode adds `thinking.block_binding` and the beta `thinking-binding-controls-2026-08-01` (not in the captured set;
  Claude Code 2.1.29 does not contain the name). (2) Changing the variant mid-session failed on `claude` (beta
  `mid-conversation-output-config-2026-07-01`; with `x-router-lossy: 1` the upstream 400s `messages.2.output_config:
  Extra inputs are not permitted`) and on `openai` GPT-6 (`configuration_update`, refused by plan usage). opencode's own
  `compatibility.supportsThinkingBlockBinding` / `supportsEffortUpdates` overrides switch both off; measured with them
  and without any lossy header on `claude`: 200, nothing dropped, the second turn at the new effort recalled the first,
  on both providers. The configuration now writes them (rule O6); opencode's resolved models carry them (ir-claude 10,
  ir-openai 16, checked through opencode's `GET /api/model` against a second daemon on the new code). The four opencode
  sources (`ai/src/protocols/{anthropic-messages,openai-responses,utils/claude-model}.ts`, `ai/src/effort-updates.ts`)
  are vendored byte-identical (21 files, 0 blob mismatches). Test processes (daemon 4142, proxy 4143, opencode services
  49398/49399) stopped; the user's daemon untouched; no router error logged.


## 5. Amendment R — project rename (2026-10-16)

The user asked to rename everything from `inference-router` to `accounts-proxy`, with `ap` as the opencode provider-id
prefix, before C7 (so the documentation is written once, under the new name). Decisions Q1–Q6 approved as recommended
(scope B including the generic word "router"; history keeps the old name; no compatibility with old names; `login
opencode` once more; GitHub repository and local directory renamed; Hindsight bank kept by `mapPathToBank`). Full
record: [project rename](../reference/2026-10-16-14-40-project-rename.md). Everything above this section is history
and keeps the old names (`ir-<provider>`, `x-router-*`, `/router/v1/models`, "router").

| # | Step | Status |
|---|---|---|
| R0 | Start from a clean tree at `fa4545f` (`bun run verify` passing) | done |
| R1 | `scripts/evidence/rename-project.ts --apply`, then `--check` (mechanical proof) | done: 236 files, 58 paths, 0 failures |
| R2 | Folders moved, `bun install` from scratch, lockfile byte-identical | done |
| R3 | Permanent check `tests/arch/legacy-names.test.ts` | done |
| R4 | AGENTS.md, README, diagram; dated notes on the rules documents; this amendment; session record | done |
| R5 | `bun run verify`; commit; push | done: GATE PASS (685 unit+component, 218 e2e, 100% on all four); commit 427c395 |
| R6 | `gh repo rename accounts-proxy`; remote URL; directory moved to `/home/mavasbel/Dev/repos/accounts-proxy`; session moved; reinstall; typecheck and unit tier | done: `mavasbel/accounts-proxy` (private), `origin/main` = 427c395; `--frozen-lockfile` no changes; typecheck, architecture and 685 unit+component tests at 100% in the new directory; the stale ignored `dist/inference-router.js` deleted |
| R7 | User: daemon stopped, data directory moved, `proxy.yaml`, daemon started, `login opencode`. Then live: accounts, model lists, one request per provider, opencode login with `ap-<provider>` | done 2026-10-17: the daemon (`bun run proxy serve` from the new directory) serves `/health` (7 providers) and `/.well-known/opencode` (`ACCOUNTS_PROXY_TOKEN`, `apps/proxy/src/main/cli.ts token`); `account list` shows an active account for all seven, `opencode`/`opencode-go` on the new Console sign-in; `GET /proxy/v1/models`: claude 14 and antigravity 24 (live), openai 7, openrouter 467, opencode 88, opencode-go 37, cheaper-inference 91 (cache); one streamed "Reply with the single word OK." per provider (claude Messages, antigravity Gemini, openai Responses, openrouter/opencode/opencode-go/cheaper-inference Chat): 7 × 200, every answer "OK", nothing dropped; opencode v2.0.26 (XDG folders under `/tmp/opencode/r7`, service port 49397) `auth login http://127.0.0.1:4141` → `opencode models` lists ap-claude 14, ap-antigravity 24, ap-openai 7, ap-openrouter 467, ap-opencode 84, ap-opencode-go 29, ap-cheaper-inference 91; `opencode run` on `ap-claude/claude-haiku-4-5-20251001` and `ap-opencode/glm-5.1` answered "OK". No WARN/ERROR in `logs/proxy.log`; the temporary opencode service stopped with SIGTERM |
| C7 | (continues as planned, under the new name) | |
