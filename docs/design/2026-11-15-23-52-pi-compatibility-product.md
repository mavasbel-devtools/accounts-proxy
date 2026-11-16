# Product design — pi compatibility

Plan: `docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`.
Architecture design: `docs/design/2026-11-15-23-52-pi-compatibility-architecture.md`.
Client: pi coding agent 1.5.2 (`/opt/homebrew/Cellar/pi-coding-agent/1.5.2`, npm `@earendil-works/pi-coding-agent`).

## 1. Purpose

pi reads its custom models from `~/.pi/agent/models.json` or from an extension's `pi.registerProvider(...)`. Each model
carries exactly one `api` (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`)
and one `baseUrl` (pi `docs/models-configuration.md:9-57`). The proxy serves 994 models (live catalog,
2026-11-15) whose accepted formats differ per provider and per model, and it never translates between formats
(`AGENTS.md` §1). A hand-written pi configuration therefore goes stale and routes models to formats they refuse.

The feature makes the proxy describe itself to pi, as it already does for opencode (`packages/dialect-opencode`):

1. a pi `models.json` document generated from the live catalog, one pi provider per proxy provider;
2. an open well-known manifest that tells pi how to get the token and the document;
3. a pi extension, shipped in this repository, that reads the manifest at pi startup and registers every provider,
   so nothing is copied by hand and nothing goes stale.

## 2. Features and use cases

Tags: `feature=<id>`, `use-case=<id>`, `dependency=<none|pi|claude|antigravity|openai|openrouter|opencode|opencode-go|cheaper-inference>`.
Every use case has a positive and a negative scenario in every tier that covers it.

Dependencies per use case (read by `scripts/gate/granularity-report.ts`): uc-pi-1, uc-pi-2, uc-pi-3 → none;
uc-pi-4, uc-pi-6 → `pi`; uc-pi-5 → `pi`, `claude`, `antigravity`, `openai`, `openrouter`, `opencode`, `opencode-go`,
`cheaper-inference`.

### Feature `pi-config` — the pi configuration document (`packages/dialect-pi`, `apps/proxy`)

#### uc-pi-1 — Print the configuration from the command line

- **Given** a data directory with enabled providers, **when** `bun run proxy pi-config` runs, **then** stdout is a
  JSON document that passes pi 1.5.2's published schema (`https://pi.dev/schemas/models.schema.json`), with one
  provider `ap-<provider>` per provider whose catalog is not `unavailable`, every model on the route of its chosen
  format (rules P1–P7, §4).
- **Negative:** `bun run proxy pi-config x` → usage error `pi-config takes no arguments` on stderr, exit `2`, empty
  stdout. A provider with no account is left out (its catalog is `unavailable`), exit `0`.

#### uc-pi-2 — Serve the configuration from the daemon

- **Given** a running daemon, **when** `GET /pi/models.json` is sent with the proxy token, **then** it answers 200 with
  the same document as uc-pi-1.
- **Negative:** no token → 401 `unauthorized` in plain JSON; `POST /pi/models.json` → 404 `not_found`.

#### uc-pi-3 — Serve the well-known manifest

- **Given** a running daemon, **when** `GET /.well-known/pi` is sent without a token, **then** it answers 200 with
  `{auth: {command, env: "ACCOUNTS_PROXY_TOKEN"}, config: {url: "<origin>/pi/models.json"}}`; the manifest carries no
  secret.
- **Negative:** `POST /.well-known/pi` → 404 `not_found`.

### Feature `pi-extension` — automatic registration inside pi (`apps/pi-extension`)

#### uc-pi-4 — Register every provider at pi startup

- **Given** a running daemon and the extension installed, **when** pi starts, **then** the extension reads the
  manifest, runs the token command once, puts the token in `process.env.ACCOUNTS_PROXY_TOKEN` when it is unset,
  reads the configuration and calls `pi.registerProvider` once per provider; `pi --list-models ap-` lists them.
- **Negative:** daemon not running, token command failing or timing out, the configuration answering 401 (a wrong
  `ACCOUNTS_PROXY_TOKEN` already set is kept, never overwritten), or a document that is not a pi configuration → pi
  still starts (exit `0`), no `ap-` provider is registered, and one warning naming the cause is written to stderr. pi exits
  `1` when an extension factory throws (pi `dist/core/extensions/loader.js:533-547`, `dist/main.js:803-808`), so the
  factory never throws.

#### uc-pi-6 — Refresh the models without restarting pi

- **Given** registered providers, **when** pi refreshes models (at startup, `/model` opens, `pi update --models`;
  pi-ai `dist/models.js:201-220`), **then** each provider's `refreshModels` re-reads the manifest (so a moved port is
  followed) and `GET /pi/models.json`, and returns that provider's current models.
- **Negative:** the daemon stopped meanwhile → `refreshModels` rejects; pi keeps the previous list (pi-ai
  `dist/models.js:211-220` collects the error per provider).

### Feature `pi-inference` — pi's requests through the proxy

#### uc-pi-5 — A pi turn on every provider and api

- **Given** the extension's providers, **when** pi sends a turn to a model of each provider on each api that provider
  serves (claude × Messages, antigravity × Gemini, openai × Responses, openrouter × Chat, opencode and opencode-go ×
  Messages, Chat, Responses, Gemini, cheaper-inference × Chat, Responses, Messages), **then** the answer arrives;
  with a tool, the tool call completes; at a thinking level, the request is accepted.
- **Negative:** through the static document (uc-pi-1 output written to a temporary `PI_CODING_AGENT_DIR/models.json`,
  no extension): on every provider, `ACCOUNTS_PROXY_TOKEN` set to a wrong value → pi exits non-zero reporting the
  proxy's 401; one extra model `nosuch` added to that provider's list → pi exits non-zero reporting the proxy's 404
  `unknown model`.

## 3. Out of scope

- Recording pi's wire traffic with the recon facility and adding pi parity replays to `verify` (needs Linux with
  bubblewrap and mitmproxy; follow-up plan).
- Translation between formats; any change to pi itself; new providers.
- The Bun pin (repository 1.4.2, host 1.4.4), the untracked plan
  `docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md`, the stale worktree record `baseline-b0eea06`.

## 4. Configuration rules P1–P7

Each rule names its evidence. The rules move verbatim to `docs/reference/<timestamp>-pi-config-rules.md` in plan step
6.1, and this section is replaced by a link, so there is one copy.

| Rule | Text | Evidence |
|---|---|---|
| P1 | One pi provider `ap-<provider>` per proxy provider whose catalog is not `unavailable`, named `AP · <name>` (the opencode names), `apiKey: "$ACCOUNTS_PROXY_TOKEN"`, no provider-level `api` or `baseUrl`. Every model carries its own `api` and `baseUrl`: pi checks both per model on the effective value and otherwise silently inherits them from another model of the provider (`findModelDefaults`). | O1 (`docs/reference/2026-10-16-01-38-model-catalog-rules.md:54`); pi `dist/core/provider-composer.js:83-90,117-123,177-180`; pi `docs/models.md:65` (`$NAME` interpolation) |
| P2 | Each model's format is the one rule O2 chooses (the reference AI SDK package's format when the model accepts it, else its first format); a model with no format is left out. Format → pi `api` and `baseUrl`: Messages → `anthropic-messages`, `<origin>/anthropic`; Chat → `openai-completions`, `<origin>/openai/v1`; Responses → `openai-responses`, `<origin>/openai/v1`; Gemini → `google-generative-ai`, `<origin>/gemini/v1beta`. | O2; pi `api/anthropic-messages.js:1026-1029` + SDK path `/v1/messages?beta=true`; `openai-completions.js:542-544`; `openai-responses.js:234-236`; `google-generative-ai.js:264-277` (`apiVersion: ""`); proxy probe 2026-11-15: `?beta=true` and a two-segment Gemini model route correctly |
| P3 | Model fields: `id` `<provider>/<model>`, `name`, `api`, `baseUrl`, `input` (the catalog's modalities restricted to `text` and `image`, the two pi accepts), `contextWindow`, `maxTokens` (`maxOutputTokens`), `reasoning`, `cost` when the catalog states one: the entry without `tier` is the base, each `{type: "context", size}` entry becomes `tiers[]` with `inputTokensAbove: size`; an unstated cache rate is `0`, pi's own value for an unstated rate. A field the catalog does not state is left out, so pi applies its documented default; subscription models state no price, so they carry no `cost`. | `AGENTS.md:126-128` (Model details); pi `providers/model-schema.js:28-46` (all four rates required when `cost` is given); `dist/core/provider-composer.js:107` (unstated cost = 0); live catalog 2026-11-15: 537 models with 1 cost entry, 99 with 2, 2 with 3 |
| P4 | Thinking: `reasoning` is `true` when the catalog says so or lists any reasoning option. A model with an `effort` option gets `thinkingLevelMap`: each pi level `minimal`, `low`, `medium`, `high`, `xhigh`, `max` maps to the same-named effort when the catalog lists it, else `null`; on `google-generative-ai` only `minimal`–`high` may be strings (pi throws on any other value), so `xhigh` and `max` are `null`; `off` is left unset (pi's default per api) except as P5 states. A model with an `effort` option on `anthropic-messages` gets `compat.forceAdaptiveThinking: true` (pi then sends `thinking: {type: "adaptive"}` plus `output_config.effort`, as pi's own catalog does for these models). A model with only `toggle` or `budget_tokens` options gets no map: pi uses its budgets. | pi-ai `providers/model-schema.js:12-23` (string or null only); `models.js:702-732`; `api/anthropic-messages.js:913-962`; `api/google-shared.js:19-31`; live catalog 2026-11-15: effort values `none minimal low medium high xhigh max`; all 12 claude effort models also list `budget_tokens` |
| P5 | Subscription cells (O6 analogue): `claude` models get `compat {supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, supportsMessageThreads: false}`, since the betas those features send (`mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01`) are outside the captured set; `openai` models get `reasoning: true` and `compat {supportsMaxOutputTokens: false, supportsMidConvoEffort: false}`, since plan usage refuses `max_output_tokens` and input items with role `system`, and pi sends the system prompt as role `developer` only when `reasoning` is `true` (pi-ai `api/openai-responses-shared.js:169`); the `off` level maps to `none` only when the catalog lists `none`, else `null`; `antigravity` models get `reasoning: false`, so pi sends no `thinkingConfig` and the proxy applies the catalog budget (wire law 13). | O6; `packages/provider-claude/src/domain/model-envelope.ts:39-51`; format fields §1 L35, §2 L86, §3 L109 |
| P6 | Gateways: each `ap-<gateway>` model gets the `compat` pi detects for that vendor's own host, so pi behaves as it does with the vendor directly. `openrouter`, Chat: `thinkingFormat: "openrouter"`, `sendSessionAffinityHeaders: true`, `sessionAffinityFormat: "openrouter"`, plus `cacheControlFormat: "anthropic"` for ids starting `anthropic/`, plus `supportsDeveloperRole: false` for ids starting neither `anthropic/` nor `openai/`. `openrouter`, Messages: `sendSessionAffinityHeaders: true`, `sessionAffinityFormat: "openrouter"`. `openrouter`, Responses: `sessionAffinityFormat: "openrouter"`. `opencode` and `opencode-go`, Chat: `supportsStore: false`, `supportsDeveloperRole: false`. `cheaper-inference`: none (pi detects nothing for its host). pi's per-model catalog `compat` is not copied: the proxy's own catalog is the only model source. | O6 ("gateways forward the request as sent"); pi-ai `api/openai-completions.js:1220-1348`, `api/anthropic-messages.js:146-164`, `api/openai-responses.js:49-51,65-80` (each run with `detectCompat`, 2026-11-15) |
| P7 | The document is `{"$schema": "https://pi.dev/schemas/models.schema.json", "providers": {...}}` and passes that schema (pi 1.5.2 copy, SHA-256 `3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc`, equal to the published one on 2026-11-15). `GET /.well-known/pi` answers `{auth: {command, env: "ACCOUNTS_PROXY_TOKEN"}, config: {url}}` with the opencode manifest's absolute token command. | O5; `/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent/schemas/models.schema.json` |

## 5. Data and states

- The document is computed per request from `DescribeModelsPort.describeModels()`; nothing is stored.
- The extension holds the token only in its process memory and `process.env`; it writes no file.
- States of the extension: `loaded` (providers registered), `degraded` (warning, no providers), `refreshing`
  (per-provider re-read; failure keeps the previous list).
