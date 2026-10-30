# Model catalog and opencode configuration rules (plan 2026-10-16, C0–C4, C6)

[Plan](../plans/2026-10-16-00-08-model-catalog-docs-plan.md). Every rule cites its source. Specs are in
`docs/reference/specs/` (SHA-256 in `manifest.json`). opencode sources are vendored byte-identical in
`packages/dialect-opencode/tests/reference/plugin-9b4ec5714d/` (`MANIFEST.json` lists the git blob of each file).

| Source | Commit | Git blob |
|---|---|---|
| opencode `packages/core/src/variant.ts` | `9b4ec5714d` (tag `v2.0.26`, 2026-10-08) | `4f3cb4e3cefba911c5cdeb4279d28d6c7a4e675b` |
| opencode `packages/core/src/aisdk-native.ts` | `9b4ec5714d` | `51d1b509c405f65e75d22e87a08cc7856838fb2f` |
| opencode `packages/core/src/models-dev.ts` | `9b4ec5714d` | `ce0c1963ca4a3d54a4a8de75b9cfdc4e673248bb` |
| opencode `packages/core/src/config/plugin/provider.ts` | `9b4ec5714d` | `a3f6265b94391cd1dbb1618435f2a8705e033b11` |
| opencode `packages/core/src/config.ts` | `9b4ec5714d` | `fce18f08aecb694592ea3ceb5ecc18efc9c7bfc5` |
| opencode `packages/core/src/config/variable.ts` | `9b4ec5714d` | `e6d7ad4d266ab769a2a99e384cfb08e94c6dd66d` |
| opencode `packages/core/src/wellknown.ts` | `9b4ec5714d` | `34b651296e62e8b2735cbdefc406bd7b932aa99b` |
| opencode `packages/schema/src/config/provider.ts` | `9b4ec5714d` | `98211cc2021ceee8d7c42580d85e1a7f3165e4b4` |
| opencode `packages/schema/src/model.ts` | `9b4ec5714d` | `743cfc61fef080b0fd03ac8c24edeef3909d0691` |
| opencode `packages/ai/src/protocols/anthropic-messages.ts` | `9b4ec5714d` | `5bb2d27d24d332decfa79e6a3ac5cdd8c7a42840` |
| opencode `packages/ai/src/protocols/utils/claude-model.ts` | `9b4ec5714d` | `244b3bd8fbad565454bd3971d350ec9082fd4bce` |
| opencode `packages/ai/src/protocols/openai-responses.ts` | `9b4ec5714d` | `b711db7805b9610e538b9eb7fa02415569a824c3` |
| opencode `packages/ai/src/effort-updates.ts` | `9b4ec5714d` | `8d97699192e8cddf419147eac8c0cd4897342ab2` |
| `https://models.opencode.ai/api.json` (extract: the six reference providers) | fetched 2026-10-16 | `models-opencode-reference.json` |
| `https://opencode.ai/config.json` (opencode's published configuration schema) | fetched 2026-10-16 | `opencode-config-schema.json` |

## 1. The detailed model record (`packages/core/src/domain/model-details.ts`)

| # | Rule | Source |
|---|---|---|
| M1 | A model's fields come from its provider's own list first; a field the provider's list does not state comes from the reference catalog; a field neither states is absent (never guessed). A list that repeats the model id as its name states no name. | Decision E3 (plan 2026-10-16 §1) |
| M2 | Reference providers: `claude` → `anthropic`, `antigravity` → `google`, `openai` → `openai`, `openrouter` → `openrouter`, `opencode` → `opencode`, `opencode-go` → `opencode-go`; `cheaper-inference` has none. Model ids match exactly. | `models-opencode-reference.json` (provider ids); coverage measured 2026-10-16 in the plan's execution record |
| M3 | Each stated field carries its source: `provider:<id>` or `models.opencode.ai:<reference provider>/<model>` (`sources`). | Decision E3 |
| M4 | The reference catalog is read from `https://models.opencode.ai/api.json` at most once per 24 h; the parsed copy is kept in `state/model-reference.json`; when it cannot be read: the stored copy, else the built-in copy generated from the committed extract (`apps/router/src/adapters/outbound/builtin-model-reference.ts`). The OpenCode catalogs take each model's format from it (rule Z5, which named models.dev before). | `models-dev.ts:281-346` (opencode v2 reads models.opencode.ai); gateway rule G5 (same fallback order) |
| M5 | `claude`, `antigravity` and `openai` models carry no price (subscription plans); gateway prices are the vendor's own, in USD per million tokens. | Decision E4 |
| M6 | Reference fields read, with their models.dev names: `name`, `description`, `family`, `release_date`, `knowledge`, `status` (`alpha`/`beta`/`deprecated`), `limit.{context,input,output}`, `modalities.{input,output}` (`text`, `image`, `audio`, `video`, `pdf`), `tool_call`, `structured_output`, `temperature`, `reasoning`, `reasoning_options` (`effort` with its values, `null`/`"null"` dropped; `toggle`; `budget_tokens` with `min`/`max`), `interleaved` (a string, or `{field}`), `open_weights`, `provider.npm` (else the provider's `npm`), `cost.{input,output,cache_read,cache_write,tiers[]}`. | `models-dev.ts` `modelInfo`, `supports`, `cost`; `models-opencode-reference.json` |

## 2. What each provider's own list states (C3)

| Provider | Fields | Source |
|---|---|---|
| `claude` | `capabilities.image_input`/`pdf_input` → input media (with text); `structured_outputs`; `thinking.supported` → reasoning; `effort.levels` → an effort option; `thinking.types.enabled` → a `budget_tokens` option with `min` 1024 | `anthropic-models-list.md` (`ModelCapabilities`); `anthropic-messages.md` (`budget_tokens` "Must be ≥1024") |
| `antigravity` | text input, plus image (`supportsImages` or an `image/*` type), audio (`audio/*`), video (`supportsVideo` or `video/*`), pdf (`application/pdf`) from `supportedMimeTypes` entries marked `true`; `supportsThinking` → reasoning | `tests/fixtures/captures/p0-live/e5/fetch-available-models.json` |
| `openai` | `description`; `input_modalities`; `supported_reasoning_levels[].effort` → an effort option | `tests/fixtures/captures/p0-live/l4/openai-models.json` |
| `openrouter` | `description`; `knowledge_cutoff`; `architecture.input_modalities`/`output_modalities` (`file` is a document input: pdf); `supported_parameters` `tools`/`structured_outputs`/`temperature`/`reasoning`; `reasoning.supported_efforts` → an effort option; `pricing.prompt`/`completion`/`input_cache_read`/`input_cache_write` (USD per token) and `pricing.overrides[].min_prompt_tokens` → context tiers | `openrouter-models.md` ("Model object schema", `supported_parameters`); `openrouter-openapi.yaml` (`InputModality`; `file_data`/`filename: document.pdf` examples); `openrouter-models.json` |
| `opencode`, `opencode-go` | the ids only; formats and every detail from the reference catalog | rule Z4; M4 |
| `cheaper-inference` | `model_type: "text"` → text in and out; `supports_vision` → image, `supports_video` → video; `supports_reasoning`; `input_per_million`/`output_per_million`/`cache_read_per_million`/`cache_write_per_million`, and the `*_above_threshold` prices above `input_token_price_threshold` as a context tier | `cheaper-inference-public-models.json` |

A cached list from before this change (gateway and OpenAI model-list copies, version 1) holds no details and is fetched
again (version 2).

## 3. The opencode v2 configuration (`packages/dialect-opencode`)

| # | Rule | Source |
|---|---|---|
| O1 | One opencode provider `ir-<provider>` per router provider (`Inference Router · <name>`), in opencode v2's native `providers` schema; the document names `$schema: https://opencode.ai/config.json` and passes that schema. A provider that could not list its models (`unavailable`) is left out. | Decisions E2, E6; `schema/src/config/provider.ts`; `opencode-config-schema.json` |
| O2 | Each model's connection package: the reference's AI SDK package when the router accepts its format for the model (`@ai-sdk/anthropic` → `@opencode/ai/providers/anthropic`, `@ai-sdk/openai` → `…/openai`, `@ai-sdk/openai-compatible` → `…/openai-compatible`, `@ai-sdk/google` → `…/google`, `@openrouter/ai-sdk-provider` → `…/openrouter`), else the package of the model's first native format (Messages → anthropic, Responses → openai, Chat → openai-compatible, Gemini → google). `settings.baseURL` is the router route of that format (`/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`); openai-compatible also names `settings.provider`. A model with no known format is left out. | `aisdk-native.ts` `PACKAGES`; `models-dev.ts` `modelInfo` (`provider` setting) |
| O3 | Model fields written: `modelID` (`<provider>/<model>`, the router's address), `name`, `family`, `package`, `settings`, `capabilities.{tools,input,output}`, `limit.{context,input,output}`, `cost[]` (`tier`, `input`, `output`, `cache.{read,write}`), `compatibility.reasoningField`, `variants`. Unstated fields are left out, so opencode applies its defaults. `variants` is always written: without it opencode derives effort variants itself. | `schema/src/config/provider.ts` `Model`; `config/plugin/provider.ts` (variants resolved only when the config has none) |
| O4 | Variants: opencode's own rules (`Variant.resolve`) for the model's package and reasoning options; ported for the five packages the router writes and checked against the vendored `variant.ts` over every reference model (`variants-parity.test.ts`). Antigravity models get none (plugin wire law 1: the thinking budget is the catalog's). The `openai` provider sends `x-router-lossy: 1` (opencode sends `max_output_tokens`, which plan usage refuses). | `variant.ts`; decision E5; live validation F5 |
| O5 | `GET /.well-known/opencode` (no token) answers `{auth: {command, env: "INFERENCE_ROUTER_TOKEN"}, remote_config: {url: <origin>/opencode/config.json, headers: {authorization: "Bearer {env:INFERENCE_ROUTER_TOKEN}"}}}`; the command is `env INFERENCE_ROUTER_HOME=<data dir> <runtime> <entry> token`, absolute, so opencode can run it from any directory. The provider settings carry `apiKey: "{env:INFERENCE_ROUTER_TOKEN}"`, which opencode substitutes with the stored credential. | `wellknown.ts` (`Manifest`, `{env:…}` substitution of `remote_config`); `config.ts:146-170` (the credential as the `auth.env` variable); `config/variable.ts` |
| O6 | `compatibility` overrides for opencode features the subscription cells refuse (live C6, 2026-10-16). Every `claude` model: `supportsThinkingBlockBinding: false` and `supportsEffortUpdates: false`. Without them opencode sends, for Claude 5.1 and later (`claude-model.ts` `supportsThinkingBlockBinding`), `thinking.block_binding` with the beta `thinking-binding-controls-2026-08-01`, and on a mid-session effort change (Opus 5 and 5.1+, `supportsEffortUpdates`) a system message with `output_config` and the beta `mid-conversation-output-config-2026-07-01`. Neither beta is in the captured set (F4), so the router answers 400 `unsupported_feature`; with `x-router-lossy: 1` the upstream refuses the message field (`messages.2.output_config: Extra inputs are not permitted`). Every `openai` model: `supportsEffortUpdates: false`; without it a mid-session effort change on GPT-6 sends a `configuration_update` input that plan usage refuses ("a feature ChatGPT token sharing doesn't support"). With the overrides opencode leaves `block_binding` out and changes the top-level effort instead (`effort-updates.ts` `stripEffortUpdates`): measured 200 on both, two turns, the second recalling the first. Gateways are left as opencode configures them itself, since they forward the request as sent. | `anthropic-messages.ts:1001-1028,1644-1660`; `claude-model.ts:14-19`; `openai-responses.ts:139-148`; `effort-updates.ts`; `schema/src/model.ts` `Compatibility`; plan C6 record |

## Amendment 2026-10-16: project rename

The project is now `accounts-proxy` ([project rename](2026-10-16-14-40-project-rename.md)). The rules above stand with the new names: the opencode provider
ids are `ap-<provider>` and their names `Accounts Proxy · <name>` (O1; `AP · <name>` since [plan 2026-10-29-14-38](../plans/2026-10-29-14-38-self-contained-cache-plan.md) S5), the detailed list is `GET /proxy/v1/models`,
the headers are `x-proxy-lossy`, `x-proxy-dropped` and `x-proxy-models-source`, the token variable in the
well-known manifest is `ACCOUNTS_PROXY_TOKEN` and its command `accounts-proxy token` (O5).
