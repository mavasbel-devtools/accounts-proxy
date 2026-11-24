# AGENTS.md — accounts-proxy laws (non-negotiable)

Plan: [docs/plans/2026-10-06-00-23-inference-router-plan.md](docs/plans/2026-10-06-00-23-inference-router-plan.md),
extended by [plan v4](docs/plans/2026-10-11-22-11-completion-plan.md) and
[P4.6](docs/plans/2026-10-12-15-35-p46-gateway-providers-plan.md) (with amendment A, the OpenCode Console),
[model catalog and docs](docs/plans/2026-10-16-00-08-model-catalog-docs-plan.md), [P6](docs/plans/2026-10-17-22-59-p6-live-results-plan.md)
and [P7](docs/plans/2026-10-18-22-09-p7-documentation-sweep-plan.md) ·
Research: [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md)

## 1. What this is
A local daemon on `127.0.0.1` that exposes the Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and
Gemini `generateContent` formats and routes each request to one of seven providers:
- subscription providers: `claude` (Anthropic Messages upstream), `antigravity` (Google Cloud Code Assist envelope
  upstream), `openai` (ChatGPT plan usage, OpenAI Responses upstream; plan v4 P4.5);
- API-key gateways (plan P4.6; the 2026-10-06 "no API-key providers" decision was reversed on 2026-10-12, N1):
  `openrouter`, `opencode` (the OpenCode Console's inference gateway, `opencode.ai/inference`), `opencode-go`,
  `cheaper-inference`.

A model accepts some formats natively (one fixed format per subscription provider; per model, or uniformly, on a
gateway); a request in any other format answers 400 `unsupported_feature`. The proxy does not translate between
formats: P5 was cancelled on 2026-10-14 and its translation-only code removed (decision D1-A,
[plan](docs/plans/2026-10-16-00-08-model-catalog-docs-plan.md)).

## 2. Architecture law (enforced by `tests/arch/architecture.test.ts`; part of `verify`)
- **Workspaces.**
  - `packages/core`: domain and ports only.
  - `packages/provider-*`: domain (pure provider rules), `ports/outbound` (provider-internal abstractions) and
    `adapters/outbound`; `provider-gateway` is the shared base the gateway vendors build on.
  - `packages/dialect-*`: `adapters/inbound` codecs.
  - `apps/proxy`: application, `adapters/{inbound,outbound}`, `composition`, `main`.
  - `apps/pi-extension`: `ports/outbound`, `application`, `adapters/outbound`, `composition`, `main` (a pi extension).
- **Layers** are recognised by path: `src/domain`, `src/ports/{inbound,outbound}`, `src/application`,
  `src/adapters/{inbound,outbound}`, `src/composition`, `src/main`. A file anywhere else under `src/` fails the gate.
- **Allowed internal imports:**
  - domain → domain
  - ports/inbound → domain, ports/inbound
  - ports/outbound → domain, ports/outbound
  - application → domain, ports
  - adapters/inbound → domain, ports/inbound, adapters/inbound
  - adapters/outbound → domain, ports/outbound, adapters/outbound
  - composition → all
  - main → composition
- **External imports** (`node:*`, third-party) are allowed only in adapters, composition and main. Domain, ports and
  application are pure TypeScript.
- **Imports are aliases, never relative.** Every import of the repository's own code is
  `@accounts-proxy/<workspace>/<subpath-with-.ts>`, also inside the same workspace (package self-reference) and in
  tests and scripts. Each workspace's `exports["./*"]` maps the subpath: `packages/*` and `apps/*` → `src/`,
  `@accounts-proxy/test-support` → `tests/support/`, `@accounts-proxy/scripts` → `scripts/`. Barrel imports are
  forbidden. The only relative or foreign-alias imports are inside the vendored parity references
  (`packages/*/tests/reference/plugin-<sha>/`): they are byte-identical to the plugin sources, and their own
  `tsconfig.json` maps the plugin's alias (`@claude/`, `@antigravity/`).
- **Declared workspace dependencies.** Bun 1.4.2 links a workspace only into workspaces that declare it, so a
  workspace imports another one only if it lists it (`"workspace:*"`; test-only use goes in `devDependencies`).
- The architecture gate enforces both rules on every `.ts` under `packages/*/{src,tests}`, `apps/*/{src,tests}`,
  `tests/` and `scripts/`. Its self-test injects relative, unresolvable and undeclared imports.
- **Abstractions.** Every port is an abstract class or interface. Every implementation extends or implements one.
  Constructor parameters and return types are abstractions (IoC). Concrete wiring happens only in `apps/proxy/src/composition`.

## 3. Wire laws carried from the source plugins (must never regress)

| Law | Origin |
|---|---|
| Antigravity `thinkingConfig.thinkingBudget` = the catalog's `thinkingBudget`, verbatim (catalog-exact) | opencode-antigravity-auth `ModelCatalogService.ts:84-99` |
| Antigravity int64 `sessionId` stays a decimal string end to end (never `Number()`) | `TrajectoryStateService.ts:64-73` |
| Claude `thinking` is rebuilt from scratch, which strips `thinking.adaptive.block_binding` and every extra key | opencode-claude-auth `RequestTransformService.ts:256-281` |
| Claude prefill guard L1/L2/L3 (no trailing assistant/tool; orphan tool results rebuilt or dropped) | `RequestTransformService.ts:86-166` |
| Antigravity trajectory labels, requestId format, step counter | `TrajectoryStateService.ts:76-204` |
| Antigravity `thoughtSignature` capture/replay; unsigned Gemini calls dropped with their results | `RequestTransformService.ts:186-277` |
| Claude identity envelope (billing block, identity block, `metadata.user_id`, `context_management`, betas) | `RequestTransformService.ts:187-298`, `ModelEnvelope.ts:49-190` |
| Claude thinking is the client's: absent stays absent, `disabled` stays disabled, and the clear-thinking `context_management` edit is sent only with thinking on (deviation F9, user decision Q6) | [P0-LIVE L1–L3](docs/reference/2026-10-10-23-17-p0-live-findings.md), [Q6 probe](docs/reference/2026-10-10-23-20-q6-thinking-probe.md) |
| Claude `count_tokens` gets the envelope without the Messages-only fields (`max_tokens`, `context_management`, `diagnostics`, `metadata`), which the upstream refuses there as extra inputs; the client's own fields pass (deviation F10, P6) | [P6 count_tokens probe](docs/reference/2026-10-18-18-39-p6-count-tokens-probe.md), captures `p6/c1–c5` |
| Antigravity Gemini cell: `functionResponse` parts move to model-role contents (law 7); only `AUTO`/`VALIDATED` function-calling modes | plugin wire law 7; P0-LIVE L6 |
| Antigravity Gemini cell: `tools.opencode.` is aliased to `tools.agy.` toward Google and restored on every answer (deviation F11): upstream 429s the exact string `tools.opencode.session_move` while quota reads 100%; the mapping is table-driven (`NAMESPACE_ALIASES` in `packages/provider-antigravity/src/domain/namespace-alias.ts`), skips with a log line on collision, holds stream chunks across frame splits | root-cause proof 2026-11-24 (verdict + UC1/UC2 in session ses_e10bf2dc1ffeyXO4xUr4xpAexn) |
| Antigravity Gemini cell media: `inlineData` of any type, `fileData` with `fileUri` (+ `mimeType`), `generationConfig.responseModalities` `TEXT`/`IMAGE` and `mediaResolution` `LOW`/`MEDIUM`/`HIGH` pass; other media keys and values are refused | [M1 media probe](docs/reference/2026-10-24-21-05-m1-media-probe.md) (captures `m1/`) |
| Antigravity Gemini cell: `parametersJsonSchema` (the Gen AI SDK's form of every `$schema` / MCP tool) travels unchanged; `parameters` keeps the law-5 whitelist | [live validation F2](docs/reference/2026-10-13-02-52-live-validation-findings.md) (j1–j4) |
| Antigravity Gemini cell: on a non-Gemini target every `functionCall` without an `id` gets `ap_call_<n>` (request-scoped, deterministic, never colliding with an id the request carries) and its `functionResponse` the same id, because Claude-on-Vertex requires `tool_use.id` and pi 1.5.2 omits ids for provider-prefixed model ids | pi 1.5.2 `pi-ai/dist/api/google-shared.js:125,235,270`; 400 `messages.1.content.0.tool_use.id: Field required` ([probe](docs/reference/2026-11-18-10-34-antigravity-tool-id-probe.md)) |
| OpenAI Responses cell: the terminal `response` gets the items of `response.output_item.done` when it arrives with an empty `output`, in the aggregated answer and in the stream (rule I6) | [live validation F1](docs/reference/2026-10-13-02-52-live-validation-findings.md) |
| OpenAI Responses cell headers: a streaming client gets `content-type: text/event-stream` when plan usage sends none, and every answer forwards `x-oai-request-id` (rule I7) | [OpenAI rules](docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md), captures `l1/openai-resp-*.json` |
| OpenAI Responses cell request, as opencode v2.1.1 sends it: the body zstd-compressed with `content-encoding: zstd`; the client's `User-Agent` and OpenCode's own headers forwarded as sent, never invented (the proxy's own `User-Agent` only when the client sends none); no explicit `accept`; the model list is the reference catalog's `openai` models with one of opencode's 16 ids, never `GET /v1/models` | recon gaps P1–P4 ([gap report §8](docs/reference/2026-10-21-20-44-recon-gap-report.md#8-openai-opencode-v211-chatgpt-sign-in)) |
| Gateway native cells: the body `model` (or Gemini path model) becomes the bare id; upstream headers are only the key header, `content-type`, the client's `accept` (not on OpenCode, recon gap O3) and, on Messages, `anthropic-version`/`anthropic-beta`; the answer streams back with `content-type`, `retry-after` and the vendor's request id | [gateway rules G1–G4](docs/reference/2026-10-12-15-35-gateway-provider-rules.md) |
| Gateway credential: `Authorization: Bearer` on every endpoint of every gateway (OpenCode since its 2026-10-12 Console migration), except OpenCode's Gemini endpoints, which take `x-goog-api-key` as OpenCode sends it | rules R1, C1, Z14, recon gap O4 |
| OpenCode Console cells: addresses `opencode.ai/inference/{openai/v1, anthropic/v1, google/v1beta}` and `/inference/go/{openai/v1, anthropic/v1, google/v1beta}` (the Gemini key in `x-goog-api-key`); the client's `User-Agent`, `x-opencode-session` and OpenCode's other own headers (`b3`, `traceparent`, `x-opencode-client`, `x-opencode-project`, session ids) forwarded as sent, never invented (the proxy's own `User-Agent` only when the client sends none, so OpenCode's free models answer opencode through the proxy); no explicit `accept`; the workspace's config headers (`x-opencode-org-id`) sent; the model lists are the reference catalog's, never the gateway's `/v1/models` | rules Z12–Z15, Z20, [Z26](docs/reference/2026-10-19-17-18-z26-opencode-free-tier-probe.md), recon gaps O1–O5 ([gap report §7](docs/reference/2026-10-21-20-44-recon-gap-report.md#7-opencode-v211-opencode-and-opencode-go-cells)) |
| OpenCode Console cells without a client `x-opencode-session`: the conversation's own id (Claude Code's `metadata.user_id` session, the Responses `prompt_cache_key`), else `ap_` + a 64-bit FNV-1a hash of the first user turn (rule Z24) | [live validation F3](docs/reference/2026-10-13-02-52-live-validation-findings.md) |
| Gateway model formats: OpenRouter every model Chat/Responses/Messages; OpenCode per model from the reference catalog's (models.opencode.ai, formerly models.dev) `provider.npm`; Cheaper Inference per model from `supported_endpoints`/`endpoint`; a model whose formats are unknown is forwarded as sent | rules R2, Z5–Z6, C3 |

## 4. Behaviour laws
- **Evidence only.** Every translation rule cites a spec in `docs/reference/specs/` or a capture in
  `tests/fixtures/captures/`. Nothing is guessed.
- **Strict translation.** A feature the target cannot carry returns 400 `unsupported_feature`. Dropping happens only
  with `x-proxy-lossy: 1`, and the response then reports `x-proxy-dropped`.
- **Quota.** 429 / quota errors are surfaced with `retry-after`. There is **no** automatic account rotation.
- **Browser login.** `accounts-proxy login <provider>` opens the browser and captures the loopback redirect.
  Paste-code exists only as the headless fallback (`--manual`). Evidence:
  [P0-E6](docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md). OpenRouter's PKCE login is a browser
  login too (it yields an API key; `--manual` is its headless page, rules R5–R7).
- **API keys** (plan P4.6 N4). A key is read only at a hidden prompt (`login cheaper-inference`, and
  `login <gateway> --key`), never from a command argument or an environment variable, and checked where the vendor
  documents a way. A key is never renewed; an upstream 401 reaches the client unchanged. OpenCode's keyless free tier
  is not available to the proxy (live 403 `FreeTierError`, rules Z8, Z21).
- **OpenCode Console** (plan P4.6 amendment A, K1–K6). `login opencode` is the Console's device login (RFC 8628)
  under the proxy's own client id `accounts-proxy`: the code is shown, the approval page opened, the token
  endpoint polled every interval (+5 s after `slow_down`). `opencode` and `opencode-go` share one account, stored as
  `opencode`. Device tokens renew under the Phase H rules (single-use refresh tokens, Z18); a key never renews. The
  credential is checked by reading the workspace config (`GET /console/api/v2/config`), whose headers the requests carry.
- **Own data** (amended by [plan 2026-10-26-23-32](docs/plans/2026-10-26-23-32-accounts-file-plan.md) and
  [plan 2026-10-29-14-38](docs/plans/2026-10-29-14-38-self-contained-cache-plan.md)). All of the proxy's data lives in
  `<repo>/.cache/` (0700, ignored by git; `ACCOUNTS_PROXY_HOME` overrides it, for tests): `proxy.yaml`, `token.json`,
  `state/`, `locks/`, `logs/`, the recon root `recon/` and the accounts file `accounts.json` (0600; the absolute path in
  `ACCOUNTS_PROXY_ACCOUNTS_FILE` overrides it). Nothing outside the repository is read or written by default. Every
  read of the accounts takes them from the file, so a hand edit applies to the next request. Every writer takes the
  locks in `<dir of the file>/locks/` (one store lock `accounts`, the renewal locks), writes atomically (temp file +
  rename) and re-reads before the rename, applying its change again over a hand edit saved meanwhile. A file that is
  not valid is an error naming it, never overwritten. The proxy never reads or writes Claude Code's, OpenCode's or the
  plugins' credential files (decision K5, `login <gateway> --from-opencode`, was withdrawn by plan 2026-10-29-14-38 S3).
- **Plugins** (user decision 2026-10-19, plan v4 §7b: P8 cancelled). This project never modifies the plugin
  repositories `opencode-claude-auth`, `opencode-antigravity-auth` and `opencode-cheaper-inference-auth`, nor the
  plugin files installed in OpenCode; the plugins and the proxy stay independent of each other.
- **Sessions** (plan v4 Phase H). Every provider session extends `OAuthSessionBase`
  (`packages/core/src/ports/outbound/session.ts`). Account files are written only through
  `CredentialStorePort.update` (a locked read → change → write); there is no blind save. Lock order is always renewal
  lock → store lock. A token-endpoint call is bounded by `TOKEN_ENDPOINT_TIMEOUT_MS` (30 s), which must stay below the
  lock staleness (60 s). A rejected refresh marks the account `needsLogin` (fast 401 until a new login); a transient
  renewal failure keeps a still-valid token for `RENEWAL_RETRY_AFTER_MS`. Claude and Antigravity retry once after
  renewing on an upstream 401, only before anything reaches the client.
- **Local access.** The daemon binds `127.0.0.1` on the configured port only (default 4141; `EADDRINUSE` is fatal).
  Every route except `/health`, `/.well-known/opencode` and `/.well-known/pi` requires the proxy token
  (`<data>/token.json`, 0600), compared in constant time. The well-known manifests carry no secret (both): the
  command that prints the token and the configuration URL (decision E1, [rules O5](docs/reference/2026-10-16-01-38-model-catalog-rules.md)).
- **Model details.** A model's detailed record takes each field from its provider's own list first, then from the
  reference catalog `models.opencode.ai` (exact ids), each field with its source; a field neither states is absent.
  Subscription models carry no price. The opencode configuration (`GET /opencode/config.json`, `opencode-config`) uses
  opencode v2's `providers` schema, one `ap-<provider>` each, variants from opencode's own rules (none for
  Antigravity; an Antigravity model's limits are its catalog's `maxTokens` / `maxOutputTokens`, never clamped,
  [plan 2026-11-02-21-29](docs/plans/2026-11-02-21-29-antigravity-real-context-window-plan.md)). `claude` and
  `openai` models carry opencode `compatibility` overrides that switch off what those cells refuse (thinking-prefix
  controls, per-message effort updates; rule O6, live C6). The pi configuration (`GET /pi/models.json`,
  `pi-config`) uses pi's `models.json` schema, one `ap-<provider>` each, every model with its own `api` and
  `baseUrl` ([rules P1–P7](docs/reference/2026-11-16-13-12-pi-config-rules.md)); `apps/pi-extension` registers
  them inside pi and runs in pi's Node.js process (no Bun API; `tests/arch/pi-extension-runtime.test.ts`).
  [Rules M1–M6, O1–O6](docs/reference/2026-10-16-01-38-model-catalog-rules.md). A fetched model list and the reference
  catalog are reused for `proxy.yaml` `modelListMaxAgeMinutes` (default 1440); `POST /proxy/v1/models/refresh` and
  `models --refresh` read them now, the latter through the running daemon when one listens
  ([plan 2026-10-26](docs/plans/2026-10-26-08-06-model-list-refresh-plan.md) R1–R2). Every list, Antigravity's included, is
  kept in memory and stored (`ModelListCacheBase`): `serve` fetches them all once at start, a read past the age or
  `MODEL_LIST_RETRY_MS` (60 s) after a failed fetch answers the kept list and fetches in the background, a failed fetch
  keeps the kept list, and every fetch logs its start and its outcome
  ([plan 2026-10-28-13-40](docs/plans/2026-10-28-13-40-cached-model-lists-plan.md) M1–M6).
- **Test seams.** `ACCOUNTS_PROXY_TEST_UPSTREAM_{CLAUDE_API,CLAUDE_OAUTH,ANTIGRAVITY_API,GOOGLE_OAUTH,OPENAI_API,
  OPENAI_AUTH,GATEWAYS}` repoint a provider's hosts for hermetic e2e only, and only to an `http://127.0.0.1:<port>`
  origin; any other value is fatal. `GATEWAYS` repoints every gateway host (OpenRouter, opencode.ai, Cheaper Inference)
  and the reference model catalog (models.opencode.ai) to one origin, paths kept.
- **Opt-in providers.** Every provider starts only with `enabled: true`; a subscription provider also needs
  `acknowledgeTermsRisk: true` in config.

## 5. Tests and gate
- Every workspace has `tests/{unit,component,live,e2e}`.
- **Coverage** is measured with Babel + istanbul (`scripts/gate/`). It must be exactly 100% lines, statements, functions
  and branches for unit+component, for e2e, and merged. It must also be **complete**: every source file with runtime
  code must be loaded by some test.
- **E2E coverage** comes from proxy processes (the source entry `apps/proxy/src/main/cli.ts`) started with
  `--preload scripts/gate/e2e-coverage-preload.ts` (`tests/support/e2e/proxy-process.ts`). A daemon must exit through
  a normal exit path (SIGTERM is handled), never a hard kill, or its coverage is lost. Upstreams are the replay server
  `tests/support/e2e/upstreams.ts`, answering only from committed captures; browser logins use the fake `xdg-open`.
  The built bundle is run separately (`apps/proxy/tests/e2e/bundle.test.ts`); it cannot carry coverage.
  Code no e2e route can reach yet is deferred by name in `scripts/gate/e2e-deferred.ts` (file, function or branch,
  each with phase and reason; an entry e2e covers, or whose name stops matching, fails the gate;
  [R1 option B](docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md)). The list is empty: the P5-only code left with
  P5 (D1-A). Plan P4.6 adds
  the phases `P4.5-live` and `P4.6-live`: code whose replay needs a live capture only the user's own sign-in or key can
  produce; such an entry leaves the list when its capture is committed and replayed (none is left since the live
  validation of 2026-10-13). Replayed answers come from committed captures or from the vendors' documented examples
  (`docs/reference/specs/`). Grants are never recorded: a replayed token answer carries the fields the proxy reads,
  and the OpenAI ID token is signed by the replay's own key (`tests/support/e2e/openai-signing.ts`).
- **Hermetic test hooks** (only with every upstream seam set; validated; read only by `main()`):
  `ACCOUNTS_PROXY_TEST_PLATFORM`, `ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS`, `ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS`,
  `ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES=1`, `ACCOUNTS_PROXY_TEST_LISTEN_UNASSIGNED=1` (binds RFC 5737
  `192.0.2.1`, so listen fails), `ACCOUNTS_PROXY_TEST_ACCOUNTS_EDITED=<n>` (the first n accounts-file writes see a hand
  edit before their rename). They exist only for paths no outside test can otherwise reach.
- **Recursive deletes** in tests go only through `tests/support/temporary.ts#removeTemporary`, which refuses anything
  outside `os.tmpdir()`.
- **`bun run verify`** runs typecheck → unit+component+arch coverage gate → build → e2e gate → merged gate → docs lint.
  It reports INCOMPLETE (exit 3) while a tier has nothing to run yet, and never reports that as a pass.
- **`bun run test:live`** runs the real accounts tier. It sets `ACCOUNTS_PROXY_LIVE=1` itself and is never part of `verify`.

## 6. Pins (exact versions only; no ranges, no `latest`)
- Bun 1.4.2
- typescript 5.9.3, @types/bun 1.4.2
- @babel/core 8.0.1, @babel/plugin-transform-typescript 8.0.1, babel-plugin-istanbul 8.0.0
- istanbul-lib-coverage 3.2.2, istanbul-lib-report 3.0.1, istanbul-reports 3.2.0
- @types/istanbul-lib-coverage 2.0.6, @types/istanbul-lib-report 3.0.3, @types/istanbul-reports 3.0.4
- e2e clients (devDependencies of `apps/proxy`, and of `@accounts-proxy/scripts` for the live matrix):
  @anthropic-ai/sdk 0.133.0, @google/genai 2.28.0, openai 7.32.0

## 7. Docs
- Files under `docs/{plans,research,issues,reference,temp}` are named `YYYY-MM-DD-HH-MM-<name>.md`, using the system clock.
- Session records are `docs/sessions/<session-id>.md`.
- README, this file, plans and diagrams are kept in exact sync with the code and the measured results after every change.
- **Diagram** (plan P7): `docs/architecture.drawio` has the pages Components, Request flow, Renewal under locks and
  Format × provider matrix. `apps/proxy/tests/unit/docs-in-step.test.ts` fails when a code name on it is not declared
  in a source file, a constant or lock name it states differs from the code, or its matrix differs from the README's.
- **Links.** The docs lint (`scripts/gate/lint-docs.ts`) fails on a relative link to a missing file and on a
  `#fragment` that names no heading of the target Markdown file.
- **Command help** (plan [2026-10-19-20-04](docs/plans/2026-10-19-20-04-recon-mitm-capture-plan.md) §24): both command
  lines (`bun run proxy`, `bun scripts/recon/cli.ts`) are trees of `CliCommand` / `CommandGroup` under a `CommandRoot`
  (`apps/proxy/src/adapters/inbound/cli/`). Every command and subcommand declares its help (usage, description,
  arguments, options with defaults, exit codes, environment, examples); `help <command>`, `<command> --help` and
  `<command> -h` print it on stdout with exit 0 and run nothing. Exit codes: 0 success and help, 1 `error: <message>`,
  2 usage error (message, the command's usage, where its help is); recon adds 3 for an isolation failure.
- **Reference documentation** (plan 2026-10-16 C7, decisions D2–D4): the [API](docs/reference/2026-10-17-19-26-proxy-api.md),
  [OpenAPI 3.1](docs/reference/2026-10-17-19-26-proxy-openapi.json), [providers](docs/reference/2026-10-17-19-26-providers.md),
  [format fields](docs/reference/2026-10-17-19-26-format-fields.md), [models](docs/reference/2026-10-17-19-26-models.md) and
  [client setup](docs/reference/2026-10-17-19-26-client-setup.md) references are kept current in place with every change.
  `apps/proxy/tests/unit/docs-in-step.test.ts` checks them against the code's routes, error codes and statuses, headers,
  commands, environment variables, limits and providers; `apps/proxy/tests/e2e/docs.test.ts` calls every OpenAPI
  operation on a real daemon and checks the answers against the document. The model reference is generated
  (`bun scripts/docs/models-reference.ts`) and must equal a fresh generation.
- **Name.** The project is `accounts-proxy` (prefix `ap`, environment `ACCOUNTS_PROXY_*`), renamed on 2026-10-16
  ([record](docs/reference/2026-10-16-14-40-project-rename.md)). No tracked path or live file carries a former name;
  historical records (dated docs, captures, vendored sources) keep the names of their time. Enforced by
  `tests/arch/legacy-names.test.ts`.
- **Recon facility** (plan [2026-10-19-20-04](docs/plans/2026-10-19-20-04-recon-mitm-capture-plan.md) §15): every
  reference client (opencode, Antigravity, Claude Code, Codex) runs only inside the bubblewrap profile sandbox
  (`scripts/recon/`). The operator's home is never bound; each profile owns `HOME`, the XDG tree, `/etc/machine-id`,
  `/etc/hostname`, `/etc/passwd`, `/etc/group` and its own per-run CA. The in-sandbox probe
  (`bun scripts/recon/cli.ts isolation`) is the acceptance check and must report `clean` with an `unchanged` guard for
  all four. Credentials are created only by an interactive login inside the profile; a client's files are never copied
  into a profile when that client rotates refresh tokens. The record is
  [2026-10-19-22-01-recon-full-isolation.md](docs/reference/2026-10-19-22-01-recon-full-isolation.md).
- **Recon capture** (plan §16): the addon (`scripts/recon/mitm/recon_addon.py`) records ordered header pairs, exact
  bodies, per-chunk SSE timing and every WebSocket frame. Redaction runs before any write from the single manifest
  `scripts/recon/shared/redaction.json`, which the live-evidence redactor also reads; a body that still matches a secret
  rule is refused, never stored, and the refusal is counted. Noise flows are labelled `noise: true`, never dropped.
  The operator's identity (account fields, identifiers inside JSON strings, the organisation UUID in URL paths, account
  headers such as `chatgpt-account-id` and every later occurrence of their value in the run) is redacted from the same
  manifest; a run recorded before a rule existed is not promotable. A workflow names the
  request it exists to produce (`expects`, per client `turnRequest`), and a run without it exits 1.
  Record: [2026-10-20-00-00-recon-capture-pipeline.md](docs/reference/2026-10-20-00-00-recon-capture-pipeline.md).
- **Recon parity** (plan §20): `bun scripts/recon/cli.ts parity <run-dir> <seq>...` compares the proxy's upstream
  request with the client's for the same call, hermetically (e2e daemon, replay upstreams, a TCP tap that keeps header
  order and case). The proxy makes only calls its client makes, in the client's shape and cadence; it never generates
  the clients' telemetry or feature-flag traffic (user decision 2026-10-21). Record:
  [2026-10-21-20-44-recon-gap-report.md](docs/reference/2026-10-21-20-44-recon-gap-report.md).
- **Recon login** (plan §18): credentials are created only by `bun scripts/recon/cli.ts run <client> --login`,
  interactively, inside the profile sandbox; the profile's home is stable and every later run reuses it, so tokens are
  never copied, exported or snapshotted (Claude and OpenAI rotate refresh tokens). opencode logs in with `--standalone`
  and every opencode run merges a free loopback `service.port` into the profile, so the sandbox never binds the
  operator's 49374. A client bundle is never patched for capture: a patched binary would not be the client whose bytes
  the goldens record. The run CA reaches every TLS stack through the environment plus a merged system bundle, and the
  probe asserts it is in the bundle. Record:
  [2026-10-20-12-13-recon-login-profiles.md](docs/reference/2026-10-20-12-13-recon-login-profiles.md).
