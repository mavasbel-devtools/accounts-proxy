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

The rules live in [the pi configuration rules reference](../reference/2026-11-16-13-12-pi-config-rules.md) (moved verbatim in plan step 6.1, so there is one copy).

## 5. Data and states

- The document is computed per request from `DescribeModelsPort.describeModels()`; nothing is stored.
- The extension holds the token only in its process memory and `process.env`; it writes no file.
- States of the extension: `loaded` (providers registered), `degraded` (warning, no providers), `refreshing`
  (per-provider re-read; failure keeps the previous list).
