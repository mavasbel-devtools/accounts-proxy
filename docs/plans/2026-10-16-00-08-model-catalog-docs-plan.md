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
| C5 | Tests at 100% (unit+component, e2e); the generated configuration validated against the pinned JSON Schema | |
| C6 | Live: opencode v2.0.26 well-known login against the daemon (temporary folders only), model list, one request per provider and per distinct variant shape (N9) | |
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

