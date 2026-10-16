# inference-router

A local LLM router. It exposes **Anthropic Messages**, **OpenAI Chat Completions**, **OpenAI Responses** and **Gemini
generateContent** endpoints on `127.0.0.1`, so any stock SDK or tool can call the models of seven providers directly:

| Provider | Sign-in | Upstream | Native formats |
|---|---|---|---|
| **`claude`** | Claude Pro/Max OAuth (browser) | Anthropic Messages | Anthropic Messages |
| **`antigravity`** | Google Antigravity OAuth (browser) | Cloud Code Assist envelope (Gemini, Claude and gpt-oss models) | Gemini |
| **`openai`** | Sign in with ChatGPT, plan usage (browser) | OpenAI Responses | OpenAI Responses |
| **`openrouter`** | OpenRouter PKCE (browser, yields an API key) | OpenRouter API | Chat, Responses and Anthropic Messages for every model |
| **`opencode`** | OpenCode Console device login (browser + code), or a service-account key (`--key`); one account shared with `opencode-go` | `opencode.ai/inference` | per model: Responses (GPT, Grok), Messages (Claude, …), Gemini, Chat |
| **`opencode-go`** | the `opencode` account (Go subscription of the same workspace) | `opencode.ai/inference/go/v1` | per model: Responses, Messages, Chat |
| **`cheaper-inference`** | Cheaper Inference API key (hidden prompt) | `api.cheaperinference.com/v1` | per model: Chat, Responses, Messages (+ `count_tokens`) |

> **Status: P4.6 with amendment A (OpenCode Console), live-validated.** Every provider serves its native formats; a
> request in another format answers 400 `unsupported_feature`: the router does not translate between formats (P5
> cancelled 2026-10-14, [plan](docs/plans/2026-10-16-00-08-model-catalog-docs-plan.md)). All seven
> providers were validated live on 2026-10-13 with the official SDKs, Claude Code and opencode, MCP tools included
> ([findings](docs/reference/2026-10-13-02-52-live-validation-findings.md)). Plans:
> [main](docs/plans/2026-10-06-00-23-inference-router-plan.md), [v4](docs/plans/2026-10-11-22-11-completion-plan.md),
> [P4.6](docs/plans/2026-10-12-15-35-p46-gateway-providers-plan.md),
> [live validation](docs/plans/2026-10-13-01-42-live-validation-plan.md).

> **Terms risk.** The subscription providers' terms restrict third-party clients. The verbatim quotes are in
> [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md) §3
> and [the OpenAI rules](docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md). `claude`, `antigravity` and
> `openai` stay disabled until their config sets `acknowledgeTermsRisk: true`; the API-key gateways need only
> `enabled: true`.

## Configuration

The router keeps everything in its own data directory, `~/.local/share/inference-router/` (override:
`INFERENCE_ROUTER_HOME`). It never reads or writes Claude Code's or the plugins' files.

| Path | Content |
|---|---|
| `router.yaml` | configuration; example: [config/router.example.yaml](config/router.example.yaml). No file = every provider disabled. Unknown keys are errors. |
| `token.json` | the router token clients present (created on first `serve` or `token`, mode 0600) |
| `accounts-<provider>.json` | the router's own accounts, tokens and API keys (atomic writes, mode 0600); `opencode-go` uses `accounts-opencode.json` |
| `state/` | per-install provider state (device and session ids, catalog caches, the reference model catalog copy `model-reference.json`, thought signatures) |
| `locks/` | cross-process lock files (token refresh) |
| `logs/router.log` | the log; never contains tokens |

## Command line

`bun run router <command>` (the workspace also declares the `inference-router` bin):

| Command | What it does |
|---|---|
| `login <provider> [--manual] [--new] [--key] [--from-opencode] [--timeout-seconds N]` | Browser sign-in for `claude`, `antigravity`, `openai`, `openrouter`: a loopback listener on `127.0.0.1` captures the redirect (default timeout 300 s). `--manual` is the headless paste-code fallback (`claude`, `openrouter`). `--new` registers another ChatGPT account (`openai`). `opencode` / `opencode-go`: the OpenCode Console device login (the code is printed, the approval page opened, the router polls until you approve). `cheaper-inference`: the API key at a hidden prompt. `--key` (gateways): enter an API key at a hidden prompt instead (an OpenCode service-account key `oc_sk_…`, an OpenRouter key). `--from-opencode` (gateways): import the API key OpenCode stores in its `auth.json` once (keys only, never OpenCode's sign-ins). Keys are checked where the vendor documents a way. |
| `account list <provider>` | stored accounts; `*` marks the active one |
| `account use <provider> <account-id>` | choose the active account (the router never switches accounts by itself) |
| `quota <provider>` | remaining quota as reported by the provider: `antigravity`, `openrouter` (key usage and limit), `cheaper-inference` (wallet) |
| `models [<provider>] [--json]` | each provider's model catalog with advertised limits, and where it came from (live, stored copy, or the built-in list; a provider that cannot list, e.g. without an account, is `unavailable`); `--json`: every model in detail (formats, limits, media, tools, reasoning options, price, …), each field with its source |
| `opencode-config` | prints the opencode v2 configuration of every model (the same document as `GET /opencode/config.json`) |
| `serve` | runs the daemon in the foreground on `127.0.0.1:<port>` (Ctrl-C or SIGTERM stops it; in-flight responses get 10 s) |
| `token` | prints the router token (created on first use) |
| `status` | checks whether a daemon answers `GET /health` on the configured port (exit 1 when not) |

Exit codes: 0 success, 1 the command failed, 2 usage error.

## Using the daemon

Start it with `bun run router serve`, then point a stock SDK at it with the router token (`bun run router token`) as
the API key. Models are addressed as `<provider>/<model>` (or an alias from `router.yaml`).

```ts
import Anthropic from "@anthropic-ai/sdk";
const claude = new Anthropic({ apiKey: TOKEN, baseURL: "http://127.0.0.1:4141/anthropic" });
await claude.messages.create({ model: "claude/claude-haiku-4-5-20251001", max_tokens: 256, messages: [{ role: "user", content: "hi" }] });

import { GoogleGenAI } from "@google/genai";
const gemini = new GoogleGenAI({ apiKey: TOKEN, httpOptions: { baseUrl: "http://127.0.0.1:4141/gemini" } });
await gemini.models.generateContent({ model: "antigravity/gemini-3.5-flash-lite", contents: "hi" });

import OpenAI from "openai";
const openai = new OpenAI({ apiKey: TOKEN, baseURL: "http://127.0.0.1:4141/openai/v1" });
await openai.chat.completions.create({ model: "openrouter/nvidia/nemotron-3.5-lightning:free", messages: [{ role: "user", content: "hi" }] });
await openai.responses.create({ model: "openai/gpt-5.6-luna", input: "hi" });
```

Coding agents work the same way (both measured live, L3 of the
[live validation](docs/reference/2026-10-13-02-52-live-validation-findings.md), MCP tools included):

- **Claude Code** (Anthropic Messages): `ANTHROPIC_BASE_URL=http://127.0.0.1:4141/anthropic`, `ANTHROPIC_API_KEY=<token>`,
  `--model claude/claude-haiku-4-5-20251001` (or any Messages model: `openrouter/…`, `opencode/claude-haiku-4-5`,
  `opencode-go/qwen3.8-flash`, `cheaper-inference/…`; set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to a routable model too).
- **opencode** (v2): `opencode auth login http://127.0.0.1:4141` reads the router's `/.well-known/opencode`, runs
  `inference-router token` for the key and loads `GET /opencode/config.json`: one provider `ir-<provider>` per router
  provider, every model with its route, limits, media, price and opencode's own variants; `claude` and `openai` models
  also switch off the opencode features those providers refuse (`compatibility.supportsThinkingBlockBinding`,
  `supportsEffortUpdates`), so changing a variant mid-session works
  ([rules O1–O6](docs/reference/2026-10-16-01-38-model-catalog-rules.md)). `bun run router opencode-config` prints the
  same document for a config file. By hand: one custom provider per format, `options.baseURL` at the router and
  `options.apiKey` the token:
  `@ai-sdk/openai-compatible` → `http://127.0.0.1:4141/openai/v1` (Chat), `@ai-sdk/openai` → the same URL (Responses;
  for `openai/*` add `options.headers: {"x-router-lossy": "1"}`, because the AI SDK sends `max_output_tokens`, which
  ChatGPT plan usage refuses), `@ai-sdk/anthropic` → `http://127.0.0.1:4141/anthropic/v1` (for `claude/*` set the
  model's `compatibility` as rule O6 does, or Claude 5.1+ requests answer 400 `unsupported_feature`), `@ai-sdk/google` →
  `http://127.0.0.1:4141/gemini/v1beta`. Model ids are `<provider>/<model>`.

| Route | Format | Served natively by |
|---|---|---|
| `GET /health` | | `{status, providers}`; no token |
| `GET /.well-known/opencode` | | the manifest of `opencode auth login <origin>` (token command, configuration URL); no token |
| `GET /opencode/config.json` | | the opencode v2 configuration of every model |
| `GET /router/v1/models` (`?provider=<id>`) | | every enabled provider's models in detail, each field with its source (`provider:<id>` or `models.opencode.ai:<provider>/<model>`) |
| `POST /anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens` | Anthropic Messages | `claude/*`; `openrouter/*`; the Messages models of `opencode`, `opencode-go`, `cheaper-inference` (`count_tokens`: `claude`, `cheaper-inference`) |
| `POST /openai/v1/chat/completions` | OpenAI Chat | `openrouter/*`; the Chat models of `opencode`, `opencode-go`, `cheaper-inference` |
| `POST /openai/v1/responses` | OpenAI Responses | `openai/*`; `openrouter/*`; the Responses models of the other gateways |
| `POST /gemini/v1beta/models/{model}:streamGenerateContent` (`?alt=sse` or a JSON array), `:generateContent` | Gemini | `antigravity/*` (near-native cell); the Gemini models of `opencode`; `:countTokens`: 400 |
| `GET /anthropic/v1/models`, `GET /openai/v1/models`, `GET /gemini/v1beta/models` | | every enabled provider's models in that dialect's shape |

Any other provider × format pair answers 400 `unsupported_feature` (no translation between formats). A gateway model whose
formats the vendor's list does not state is forwarded in the client's format, and the gateway answers it.

The token is accepted as `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`. Errors use each dialect's
own error shape; upstream errors on the native cells pass through with their status, body and `retry-after`.

Router errors:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request`, `unsupported_feature` | the request cannot be served as sent |
| 401 | `unauthorized` | missing or wrong router token |
| 401 | `provider_auth_required` | no usable login: no account, an unreadable one, or one whose refresh was rejected (`account list` shows it as `[needs login: …]` until `login <provider>`) |
| 404 | `unknown_model`, `unknown_account`, `not_found` | unknown model address, account or route |
| 413 | `payload_too_large` | request body over the limit |
| 429 | `quota_exhausted` | provider quota, with `retry-after` when known |
| 502 | `upstream_unreachable` | no HTTP answer from the provider (DNS, refused, reset) |
| 503 | `provider_disabled` | the provider is not enabled in `router.yaml` |
| 504 | `upstream_timeout` | the provider sent nothing for the idle timeout |
| 500 | `internal_error` | a router defect (details in the log) |

Sign-in sessions (plan v4 Phase H): an access token is renewed 2 minutes before it expires, once for all concurrent
requests and processes. A renewal never undoes a concurrent `login` or `account use` (every account-file write is a
locked read-change-write), each token call is bounded by 30 s, and a renewal that fails transiently (5xx, timeout,
unreachable) keeps using a token that is still valid, retrying after 30 s. On `claude`, an upstream 401 renews the
token once and resends the request before anything reaches the client.

Router headers:

| Header | Direction | Meaning |
|---|---|---|
| `x-router-lossy: 1` | request | drop (instead of rejecting with 400 `unsupported_feature`) what the target cannot carry |
| `x-router-dropped` | response | every feature or element removed from the request, comma-separated — lossy drops and the always-applied wire laws (unsigned Gemini function calls, empty contents, trailing model turns) |
| `x-router-models-source` | response (model lists) | one `provider=source` pair per provider, e.g. `claude=cache,antigravity=live`; source is `live`, `cache` or `static` |

Notes from the live measurements ([P0-LIVE findings](docs/reference/2026-10-10-23-17-p0-live-findings.md)):

- **claude:** a request without `thinking` is sent without thinking, and `thinking: {type: "disabled"}` is honoured
  (decision Q6). Only `anthropic-beta` names in the model's captured set are forwarded; others are 400. Stop
  sequences also match inside thinking text (L4).
- **antigravity:** `thinkingBudget` must be the catalog's value (it is injected when absent); `maxOutputTokens` may
  not exceed the catalog's. Function-calling modes other than `AUTO`/`VALIDATED` are 400 (the upstream ignores or
  rejects them, L6). Tool schemas in `parameters` may use only `type, format, description, nullable, enum, items,
  properties, required, propertyOrdering`; a full JSON Schema in `parametersJsonSchema` (how the Gen AI SDK sends MCP
  tools) travels unchanged (live F2). The model list is the upstream catalog minus its tab/deprecated ids and can include IDE
  helper models such as `tab_*` (L13).
- **API-key gateways** ([rules](docs/reference/2026-10-12-15-35-gateway-provider-rules.md)): the body `model` (or the
  Gemini path model) becomes the vendor's bare id; only the key (`Authorization: Bearer`), `content-type`, `accept`
  and, on Messages, `anthropic-version`/`anthropic-beta` travel upstream; the answer (status, body, `retry-after`, the
  vendor's request id) streams back unchanged, errors included. Model lists: OpenRouter's, OpenCode's and Cheaper
  Inference's own lists (OpenCode formats from models.dev), live → stored copy (24 h) → built-in copy of the committed
  lists. OpenCode's keyless free tier answers 403 `FreeTierError` "can only be used from within OpenCode" to any other
  client, so `opencode` needs a sign-in or a key.
- **OpenCode Console** (rules §3a): requests also carry the router's `User-Agent`, the workspace's headers from the
  Console config (`x-opencode-org-id`) and the client's `x-opencode-session`. OpenCode Go refuses a request without
  it (400 `MissingSessionID`); when a client sends none (Claude Code does not), the router sends the conversation's own
  id (Claude Code's session, the Responses `prompt_cache_key`) or a stable `rtr_…` id derived from the conversation's
  first user turn (rule Z24, live F3).
- **openai:** ChatGPT plan usage ends a stream with an empty `response.output`; the router fills it with the streamed
  items, so non-streamed answers and the SDKs' `finalResponse()` carry the output (rule I6, live F1).
- **Model-list fields the catalogs do not have** are neutral markers, never invented values: Antigravity models list
  `created_at: 1970-01-01T00:00:00Z` (Anthropic shape) and `created: 0` (OpenAI shape); Gemini-shape `version` is the
  provider id and `baseModelId` the routable `<provider>/<model>` (decision Q5).

## Format × provider matrix

| Inbound format \ Provider | claude | antigravity | openai | openrouter | opencode | opencode-go | cheaper-inference |
|---|---|---|---|---|---|---|---|
| Anthropic Messages | native | — | — | native | native per model | native per model | native per model |
| OpenAI Chat Completions | — | — | — | native | native per model | native per model | native per model |
| OpenAI Responses | — | — | native | native | native per model | native per model | native per model |
| Gemini generateContent | — | near-native | — | — | native per model | — | — |

"Native per model": the models whose list entry names that format. "—": 400 `unsupported_feature`.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    A[Anthropic SDK / Claude Code]
    O[OpenAI SDK / tools]
    G[Google GenAI SDK]
  end
  subgraph apps/router
    H[NodeHttpServer + RouteHandler, router token]
    S[Application services]
    C[composition root]
  end
  subgraph dialects[packages/dialect-*  inbound codecs]
    DA[anthropic]
    DO[openai]
    DG[gemini]
    DC[opencode config]
  end
  subgraph core[packages/core]
    D[core domain]
    P[ports]
  end
  subgraph providers[packages/provider-*  outbound adapters]
    PC[claude]
    PA[antigravity]
    PO[openai]
    PG[gateway base: openrouter, opencode, opencode-go, cheaper-inference]
  end
  A --> H
  O --> H
  G --> H
  H --> DA & DO & DG & DC --> S
  S --> P
  P -.implemented by.-> PC & PA & PO & PG
  PC --> X[(api.anthropic.com)]
  PA --> Y[(cloudcode-pa.googleapis.com)]
  PO --> Z[(api.openai.com)]
  PG --> W[(openrouter.ai · opencode.ai · api.cheaperinference.com)]
  C -.wires.-> H & S & PC & PA & PO & PG
```

The full component diagram is [docs/architecture.drawio](docs/architecture.drawio). The architecture rules are in
[AGENTS.md](AGENTS.md).

Workspaces:

| Workspace | Directory | Role |
|---|---|---|
| `@inference-router/core` | `packages/core` | domain and ports |
| `@inference-router/provider-claude` | `packages/provider-claude` | Claude subscription provider |
| `@inference-router/provider-antigravity` | `packages/provider-antigravity` | Antigravity provider |
| `@inference-router/provider-openai` | `packages/provider-openai` | OpenAI provider (Sign in with ChatGPT plan usage) |
| `@inference-router/provider-gateway` | `packages/provider-gateway` | shared base of the API-key gateways (native cells, catalogs, key sessions and logins) |
| `@inference-router/provider-{openrouter,opencode,cheaper-inference}` | `packages/provider-*` | the gateway vendors' rules, logins, catalogs and quota |
| `@inference-router/dialect-{anthropic,openai,gemini}` | `packages/dialect-*` | dialect codecs: router errors and model lists |
| `@inference-router/dialect-opencode` | `packages/dialect-opencode` | the opencode v2 configuration and well-known manifest; opencode's variant rules |
| `@inference-router/router` | `apps/router` | application, adapters, composition, CLI |
| `@inference-router/test-support` | `tests/support` | shared test doubles, guarded temp directories, e2e replay upstreams and process runner |
| `@inference-router/scripts` | `scripts` | release gate and evidence scripts |

Every import of the repository's own code uses the workspace name, `@inference-router/<workspace>/<subpath>.ts`,
also inside one workspace. Relative imports are rejected by the architecture gate.

## Development

| Command | What it does |
|---|---|
| `bun install` | install the pinned toolchain (Bun 1.4.2) |
| `bun run typecheck` | `tsc --noEmit` over every workspace, test and script |
| `bun run test` | unit + component + architecture + support tests |
| `bun run coverage` | same set under istanbul; fails below 100% lines/statements/functions/branches or if a source file is never loaded |
| `bun run test:e2e` | e2e tier: the real entry as child processes under the coverage preload, the official SDKs, replay upstreams; then the e2e-alone coverage gate (100%; the deferral list is empty: [R1](docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md)) |
| `bun run test:live` | real-account tier (never part of `verify`) |
| `INFERENCE_ROUTER_LIVE=1 bun scripts/evidence/live/l1-live-matrix.ts` | the live matrix: every provider's native cells through the daemon with the official SDKs (about 80 small requests; `--only=`, `--scenarios=`) |
| `bun run verify` | the full release gate |
| `bun run fetch:specs` | re-fetch the official wire specs into `docs/reference/specs/` |
| `bun scripts/evidence/gateway-snapshots.ts` | regenerate the gateways' built-in model lists from the committed vendor lists |

## Evidence

- [P0-E1/E5: wire specs and default port](docs/reference/2026-10-06-00-32-p0-e1-e5-specs-and-port.md)
- [P0-E6: browser-login mechanisms](docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md)
- [P0-LIVE findings](docs/reference/2026-10-10-23-17-p0-live-findings.md) ·
  [E2 captures](docs/reference/2026-10-10-22-57-p0-live-e2-captures.md) ·
  [E3 fidelity matrix](docs/reference/2026-10-10-23-17-fidelity-matrix.md) ·
  [Q6 thinking probe](docs/reference/2026-10-10-23-20-q6-thinking-probe.md)
- [P4 e2e coverage, risk R1 and its resolution](docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md) ·
  [P4 live daemon smoke](docs/reference/2026-10-11-11-47-p4-live-daemon-smoke.md)
- [E4 refresh-token rotation](docs/reference/2026-10-11-23-06-e4-refresh-rotation.md) ·
  [OpenAI ChatGPT plan rules](docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md)
- [Gateway provider rules](docs/reference/2026-10-12-15-35-gateway-provider-rules.md) ·
  [P4.6 gateway live probe](docs/reference/2026-10-12-16-09-p46-gateway-live-probe.md)
- [Live validation of all seven providers (L0–L4)](docs/reference/2026-10-13-02-52-live-validation-findings.md)
