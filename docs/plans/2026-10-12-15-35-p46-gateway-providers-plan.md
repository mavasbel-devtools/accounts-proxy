# Plan P4.6: API-key and gateway providers (`openrouter`, `opencode`, `opencode-go`, `cheaper-inference`)

Extends (never replaces) [plan v4](2026-10-11-22-11-completion-plan.md) and the
[main plan](2026-10-06-00-23-inference-router-plan.md) (section "Changes v4 → v4.1"). Requested by the user on 2026-10-12:
"we should add more providers … cheaper inference, the actual opencode API (and opencode go), openrouter … could we
continue adding them while we are still not logged into openai?" Approved with "Could we proceed?" (2026-10-12).

## 0. Decisions (approved 2026-10-12)

| # | Decision |
|---|---|
| N1 | The 2026-10-06 decision "no API-key providers" is **reversed** for the four providers below (AGENTS.md §1 amended). |
| N2 | Provider ids are opencode's: `openrouter`, `opencode` (Zen), `opencode-go`, `cheaper-inference`. |
| N3 | One vendor package per provider on a shared gateway base; no user-defined custom gateways (they could not be evidence-backed). |
| N4 | API keys are entered only at a hidden prompt of `login <id>` and stored only in the router's 0600 account files; never a command argument or an environment variable. |
| N5 | OpenCode Console device-code login only if its token is proven to work on Zen/Go; otherwise API key only. |
| N6 | No price/metadata merging from OpenRouter/LiteLLM/models.dev (the router does not bill); each model list comes from the provider's own catalog. |
| N7 | Order: P4.6 → P5 → P4.5 live part (when the user signs in to OpenAI) → P6–P9. |
| N8 | Accounts: **open** (the user has not said which accounts exist). Code and unit/component tests do not wait; each provider's live step waits for its credential (Zen's keyless free tier is not open to the router: §2 item 5). |
| N9 | Live tests use free models first, else the smallest prompts, about 10 requests per provider. |
| O3 | The repository stays private until everything works (user, 2026-10-12). |

## 1. Evidence (fetched 2026-10-12, SHA-256 in `docs/reference/specs/manifest.json`)

| Provider | Sources |
|---|---|
| `openrouter` | `openrouter-openapi.yaml` (servers `https://openrouter.ai/api/v1`; `POST /chat/completions`, `/responses`, `/messages`; `GET /models`, `/key`; `POST /auth/keys`; bearer auth), `openrouter-oauth-pkce.md`, `-authentication.md`, `-streaming.md`, `-errors.md`, `-limits.md`, `-models.md`, `-free-variant.md`, `-claude-code.md` |
| `opencode`, `opencode-go` | opencode @ `35ef229454`: `packages/web/src/content/docs/{zen,go}.mdx` (endpoint per model), `packages/console/app/src/routes/zen/**` and `src/lib/inference-proxy.ts` (paths, key header per endpoint, keyless free models), `packages/core/src/plugin/provider/opencode.ts` (Console device login, `apiKey: "public"`); `opencode-{zen,go}-models.json` (live public lists); `models-dev-gateways.json` (models.dev entries, per-model `provider.npm`) |
| `cheaper-inference` | `cheaper-inference-llms-full.txt` (official docs corpus), `cheaper-inference-openapi.json`, `cheaper-inference-public-models.json`; plugin `opencode-cheaper-inference-auth` @ `f2c5e23` |

The rules document [2026-10-12-15-35-gateway-provider-rules.md](../reference/2026-10-12-15-35-gateway-provider-rules.md)
cites a source for every rule.

## 2. Design

1. **Wire formats per model.** Core gains `WireFormat = anthropic-messages | openai-chat | openai-responses | gemini`.
   A route maps to one format (`/anthropic/v1/messages*` → anthropic-messages, `/openai/v1/chat/completions` →
   openai-chat, `/openai/v1/responses` → openai-responses, `/gemini/v1beta/models/*` → gemini). `ProviderPort` replaces
   `nativeDialect` with `nativeFormats(model)`; the three subscription providers return one fixed format, a gateway returns
   the model's formats from its catalog. A request whose format the model does not accept natively is a translated cell
   (P5): 400 `unsupported_feature` until then. Model catalogs carry `formats` (provider default) and per-model `formats`.
2. **OpenAI Chat Completions becomes a routed format** (it answered 400 for every model before): forwarded where native.
3. **API-key accounts.** `AccountCredential.data = { apiKey }`; the id is the provider's account identity when it has
   one (Cheaper: e-mail from `GET /v1/account`; OpenRouter: `user_id` of the key exchange), else `key-<8 hex of
   SHA-256(key)>`. A fixed key is never renewed; an upstream 401 passes through unchanged.
4. **Login.** `login openrouter`: PKCE browser login (`callback_url=http://localhost:<port>/callback`, S256, `state`),
   code exchanged at `POST /api/v1/auth/keys` for a key; `--manual`: the headless variant (no `callback_url`, the page
   shows the code). `login opencode | opencode-go | cheaper-inference`: hidden key prompt, then one authenticated check
   where the provider documents one (Cheaper `GET /v1/account`, Go `GET /zen/go/v1/usage`); Zen has no authenticated
   read endpoint, so its key is checked for the documented prefixes (`oc_sk_`, legacy `sk-`).
5. **Keyless Zen: dropped (live evidence, 2026-10-12).** opencode sends the key `public` when it has none
   (`opencode.ts`), and the gateway forwards keyless requests for free models (`inference-proxy.ts`). A live check from
   this machine (`POST https://opencode.ai/zen/v1/chat/completions`, model `big-pickle`, once with `Bearer public` and
   once with no key) answered **403** `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier
   can only be used from within OpenCode"}}` both times. The router does not imitate OpenCode, so `opencode` needs a key
   like the other gateways. The check is repeated and captured by the step 5 probe.
6. **Gateway base** (`packages/provider-gateway`): one `GatewayProvider` (passthrough: body `model` rewritten to the bare
   id, path mapped to the vendor's endpoint, key sent in the endpoint's header, response streamed back unchanged with
   `content-type`, `retry-after` and the vendor's request id) and one `GatewayCatalog` (live → cache 24 h → built-in
   snapshot generated from the committed lists). Each vendor package supplies a `GatewaySpec`.
7. **Seams.** One hermetic seam `INFERENCE_ROUTER_TEST_UPSTREAM_GATEWAYS` repoints every gateway host (OpenRouter,
   opencode.ai, Cheaper Inference, models.dev) to one loopback replay origin, paths kept. The test hooks then need all
   seven seams.
8. **Quota.** `quota openrouter` (`GET /key`: usage, limit, remaining) and `quota cheaper-inference`
   (`GET /v1/account/balance`), both from their OpenAPI documents. `opencode-go`'s `usage` response is undocumented:
   added only after its live capture.

## 3. Steps

| Step | Content | State |
|---|---|---|
| 0 | Evidence: specs fetched with provenance, opencode/cheaper sources pinned, rules document | done |
| 1 | Core: `WireFormat`, catalog formats, `nativeFormats`, API-key account helpers, routing by format | done |
| 2 | `provider-gateway` base; vendor packages `provider-openrouter`, `provider-opencode`, `provider-cheaper-inference` | done |
| 3 | Router: routes, key login (hidden prompt), OpenRouter PKCE login, seams, quota, CLI help | done |
| 4 | Unit + component tests 100%; e2e replaying committed captures | done (the paths that need an accepted key are deferred `P4.6-live`) |
| 5 | Live: keyless Zen free models now; each other provider when its credential exists (N8) | keyless Zen done (403, Z8); per-key probes wait for the user's keys |
| 6 | Docs: AGENTS.md §1/§3/§4, README, diagram, plans, session record | done |

## 4. Execution record

- 2026-10-12 15:35 Plan written; step 0 started.
- 2026-10-12 17:08 Steps 0–4 and 6 done; step 5 partly. Core routes by `WireFormat` (`ProviderPort.nativeFormats`); the
  `provider-gateway` base serves every native cell (bare model id, key header per endpoint, answer unchanged) and
  lists models live → 24 h copy → built-in (generated from the committed vendor lists: OpenRouter 459, Zen 83, Go 38,
  Cheaper Inference 91). Logins: OpenRouter PKCE (browser and `--manual`), hidden-prompt keys for the other three
  (format check for OpenCode, `GET /usage` for Go, `GET /v1/account` for Cheaper Inference). `quota` for OpenRouter
  (`GET /key`) and Cheaper Inference (wallet) prints the vendor's fields as answered. New route
  `POST /openai/v1/chat/completions` is native on the gateways. Live probe
  ([2026-10-12-16-09](../reference/2026-10-12-16-09-p46-gateway-live-probe.md)): Zen without a key and with `public`
  both answered 403 `FreeTierError` "can only be used from within OpenCode" (rule Z8), so `opencode` needs a key.
  e2e replays the committed vendor lists, OpenRouter's documented OpenAPI examples and the captured Zen refusal;
  code that needs an accepted key's live answer is deferred `P4.6-live` (3 entries), the OpenAI sign-in's
  `P4.5-live` (13), P5 (12). `bun run verify`: GATE PASS (646 unit+component, 193 e2e, 100% everywhere).
  Waiting for the user: keys/accounts (N8) for the per-provider live probes
  (`INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/p46-gateway-probe.ts`), and the OpenAI sign-in.

## 5. Amendment A — the 2026-10-12 OpenCode Console (decisions K1–K6, approved 2026-10-12)

On 2026-10-12 OpenCode moved Zen and Go into the new **OpenCode Console**: new inference addresses, service-account
API keys (`oc_sk_…`, created under *Keys*), and a documented device login that "other CLIs can use"
(upstream `b9ca4d21b4` removed the legacy key database; `25053bbdc7` replaced the Zen/Go docs). Evidence:
`docs/reference/specs/opencode-console-{intro,api,inference-api,models,go}.html` (manifest.json),
[live probe 2026-10-12-23-40](../reference/2026-10-12-23-40-p46a-console-live-probe.md), rules §3a of the
[rules document](../reference/2026-10-12-15-35-gateway-provider-rules.md). Rules Z1–Z3, Z7, Z10 and Z11 are superseded
by §3a (kept for the record).

| # | Decision (approved) |
|---|---|
| K1 | `login opencode` uses the Console device login (RFC 8628) under the router's own client id `inference-router` |
| K2 | `opencode` and `opencode-go` share one Console account (stored as `opencode`; `login`/`account` on `opencode-go` act on it) |
| K3 | `login <gateway> --key` keeps the hidden-prompt key entry (service-account key for OpenCode) |
| K4 | The credential is checked, and the workspace's request headers are taken, from `GET /console/api/v2/config` |
| K5 | `login <gateway> --from-opencode`: one-time import of an **API key only** (never a sign-in token) from OpenCode's `auth.json`; the router only reads that file (amends "Own credentials") |
| K6 | This amendment before P5 |

Steps:

| # | Step | Status |
|---|---|---|
| A0 | Evidence: Console docs and new model lists fetched with provenance; keyless live probe; rules §3a | done |
| A1 | Core: shared-account owner (`opencode-go` → `opencode`), device-login port, login options `--key`/`--from-opencode` | done |
| A2 | `provider-opencode`: new addresses (bearer everywhere, `User-Agent`, client `x-opencode-session` forwarded), device login client, Console session (device tokens renewed under the Phase H rules; keys fixed), config check | done |
| A3 | Router: login service (device flow, key, import), CLI flags, composition; `openrouter` gets a key login for `--key`/`--from-opencode` | done |
| A4 | Tests 100% (unit, component, e2e replaying the Console's documented examples) | done (the approved device sign-in and its renewal are deferred `P4.6-live`) |
| A5 | Live, after the user's `login opencode`: config, one small request per format (≈10 requests, N9) | waiting for the user's `login opencode` |
| A6 | Docs: AGENTS.md, README, rules, plan record, session record | done |

Execution record (amendment A):

- 2026-10-13 00:56 A0–A4 and A6 done; A5 waits for the user's `login opencode`. Keyless live probe
  ([2026-10-12-23-40](../reference/2026-10-12-23-40-p46a-console-live-probe.md)): the new addresses answer (401
  without a workspace, Go 400 `MissingSessionID` without `x-opencode-session`, the free model still 403
  `FreeTierError`), the device-code request under client id `inference-router` is accepted, and its first poll answers
  400 `authorization_pending`. Every gateway key is now a bearer token (`keyHeader` removed from the gateway base).
  `--key` and `--from-opencode` work for every gateway with a key login (OpenRouter got one). Found and fixed on the
  way: the paste-code and hidden-key prompts waited forever (and spun) when standard input ended before a line; they
  now fail with "standard input ended before a line was entered". The e2e daemon starter now waits up to 30 s and
  stops a daemon that did not start (orphaned daemons from earlier aborted runs were found and stopped).
