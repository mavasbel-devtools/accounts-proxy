# PLAN — `inference-router`: local multi-dialect LLM router built from the mavasbel auth plugins

Date: 2026-10-06 00:23 · Status: **LOCKED v3.1 — APPROVED 2026-10-06 ("Confirmed. Could we proceed?") — IN EXECUTION**; extended by v4 (below).

## Changes v4 → v4.1 (user, 2026-10-12)

- **API-key gateways added** ([plan P4.6](2026-10-12-15-35-p46-gateway-providers-plan.md)): `openrouter`,
  `opencode` (OpenCode Zen), `opencode-go`, `cheaper-inference`. This reverses the 2026-10-06 decision "no API-key
  providers" (decision N1); every earlier text that says otherwise stays as written and is superseded here.
- **Routing by wire format.** A model accepts some formats natively (`anthropic-messages`, `openai-chat`,
  `openai-responses`, `gemini`): one fixed format per subscription provider, per model or uniform on a gateway. OpenAI
  Chat Completions is now a routed format (native on the gateways). The v4 matrix (4 formats × 3 providers) grows to
  4 formats × 7 providers; P5 translates only the pairs no provider serves natively.
- **Order** (decision N7): P4.6 → P5 → P4.5 live part (when the user signs in to OpenAI) → P6–P9.
- The repository stays private until everything works (user, 2026-10-12; O3).

## Changes v3.1 → v4 (user, 2026-10-11)
- **Plans are only extended, never replaced** (user rule 2026-10-11). Everything below this section stays as written;
  parts no longer in force are marked "superseded by v4".
- **Third provider `openai`** through OpenAI's official "Sign in with ChatGPT" plan usage flow (`api.openai.com/v1`,
  Responses API), extracted from opencode's built-in `packages/core/src/plugin/provider/chatgpt.ts` @ `35ef229454`,
  with opencode's request headers (`session-id`, `thread-id`, `x-client-request-id`).
- **Fourth inbound dialect: OpenAI Responses** (`POST /openai/v1/responses`), moved forward from P10. Matrix v4 is
  4 dialects × 3 providers = 12 cells (3 native, 9 translated); it supersedes §1.
- **Phase H** (hardening of renewal and failure handling, gaps H1–H7) and **Phase P4.5** (the `openai` provider and the
  native Responses cell) are inserted before P5.
- Full detail, decisions H-Q1…H-Q6 and O1…O12, and the execution record:
  [2026-10-11-22-11-completion-plan.md](2026-10-11-22-11-completion-plan.md).

## Changes v3 → v3.1 (user, 2026-10-10)
- **Provider id `claude-subscription` → `claude`.** No alias is kept. `antigravity` is unchanged. Commands are `inference-router login claude` / `login antigravity`; the config key is `claude:`; model addresses are `claude/<model-id>`; files are `accounts-claude.json` and `state/claude/...`. The module `claude-subscription-provider.ts` and the class `ClaudeSubscriptionProvider` keep their names: they describe the credential source, not the id.
- **Machine migration Windows → Linux.** Validation evidence: [docs/reference/2026-10-10-18-45-linux-migration-validation.md](../reference/2026-10-10-18-45-linux-migration-validation.md).

| Item | Before (Windows) | Now (Linux, measured 2026-10-10) |
|---|---|---|
| Repo | `C:\Users\Marco\Dev\AIML\inference-router` | `/home/mavasbel/Dev/repos/inference-router` |
| Plugin repos | `…\Dev\AIML\tools\opencode-{claude,antigravity}-auth` | `/home/mavasbel/Dev/repos/opencode/opencode-{claude,antigravity}-auth` (pinned commits `6292741`, `5c6f7c2` present) |
| Data directory | `~/.local/share/inference-router/` | same path under `/home/mavasbel` |
| Scratch directory | `%TEMP%\opencode` | `/tmp/opencode` |
| Pre-repo docs (`AIML/tools/docs/…`: v1 plan, first session record) | present | **not present on this machine**; the repo's own `docs/` holds the plan, research and session record |

## Changes v2 → v3 (user, 2026-10-06)
- **C1 confirmed:** no API-key providers at all (Cheaper excluded); OpenAI dialect has only translated cells.
- **D10 (new) Browser login mandatory:** for every supported provider that offers it, `inference-router login <provider>` opens the system browser and completes the OAuth flow **automatically through a loopback redirect** (`http://localhost:<port>/...` captured by a local callback server) — no copy/paste. Antigravity: loopback already proven (`LoopbackCallbackServerAdapter.ts`). Claude: the plugin uses paste-code (`redirect_uri https://platform.claude.com/oauth/code/callback`); whether the Claude OAuth client accepts a loopback redirect is **UNVERIFIED** and is settled in P0-E6 from the official Claude Code distribution. Paste-code remains only as the fallback when the browser/loopback cannot be used (headless), never as the default.
- **P0 storage:** the repo directory `AIML/inference-router` is created with `git init` at the start of P0 so evidence lands directly in its `docs/reference/` and `tests/fixtures/captures/`; scaffolding is still P1.
- **Execution amendment A1 (2026-10-06 00:32, forced by D5 + D10):** E2/E3/E4 need live calls. D5 forbids using the shared Claude Code / plugin credentials, so they can only run on the router's own logins, and the logins are code written in P3 that the user completes in the browser. The order is therefore: P0-E1/E5/E6 (done) → P1 → P2 → P3 (providers + `login`) → **P0-LIVE gate: the user runs `inference-router login claude` and `login antigravity` → E2/E3/E4 executed** → P4 → P5. Until then, P3 parity tests use the real sanitized captures already committed in the plugins (`opencode-claude-auth/test/fixtures/*`: text, tool use, thinking, refresh, catalog, 400 errors; `opencode-antigravity-auth/test/fixtures/capture/*`: stream, models, quota), copied with provenance. P5 translated mappings still wait for E3.
- **P0-E6 (new):** determine, from the official Claude Code package, the browser-login mechanism (redirect URIs, port selection, callback path, success redirect, state/PKCE handling) and measure it live during the router's first login.
Supersedes: `docs/plans/2026-10-06-00-14-llm-router-plan.md` (v1).
Research basis: `docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md` (every `file:line` citation lives there).

## Changes from v1 (user answers, 2026-10-06)

| v1 item | User answer | Effect in v2 |
|---|---|---|
| D1–D9 | "Ok" | Accepted as written, with the edits below. |
| §5.2 subscription providers | "turned on" | `claude` and `antigravity` are both **in scope and enabled** in this machine's config. The code default stays disabled, gated by `acknowledgeTermsRisk: true`. |
| §5.2 API-key providers | "no API keys" | **No API-key provider in scope.** Removed: `AnthropicApiKeyProvider`, `provider-openai-compat`, the `cheaper` instance, and the `catalog` package, whose only consumer was the key-provider path. The matrix shrinks from 3×3 to 3×2. Cheaper Inference is also an API-key provider, so it is excluded under this reading. **Confirm item C1.** |
| §5.3 name and location | `inference-router` in `AIML/inference-router` | Repo `C:\Users\Marco\Dev\AIML\inference-router`, package scope `@inference-router/*`, CLI `inference-router`, private GitHub repo `mavasbel/inference-router`, data directory `~/.local/share/inference-router/`, live flag `INFERENCE_ROUTER_LIVE=1`. The path was measured ABSENT on 2026-10-06 00:23. Since 2026-10-10 the repo is `/home/mavasbel/Dev/repos/inference-router` (v3.1). |

---

## 0. Decisions (locked unless noted)

| # | Decision | Content |
|---|---|---|
| D1 | Reuse strategy | **R1, phased.** A new Bun-workspace monorepo (`/home/mavasbel/Dev/repos/inference-router` since v3.1), with provider packages extracted from `opencode-claude-auth` @ `6292741` and `opencode-antigravity-auth` @ `5c6f7c2`. The shipped plugins stay **untouched** until the router is validated. Switching them to the packages is P8, behind its own approval gate. |
| D2 | Inbound dialects | **Anthropic Messages:** `POST /anthropic/v1/messages`, `POST /anthropic/v1/messages/count_tokens`, `GET /anthropic/v1/models`. **OpenAI Chat Completions:** `POST /openai/v1/chat/completions`, `GET /openai/v1/models`. **Gemini:** `POST /gemini/v1beta/models/{model}:generateContent`, `POST /gemini/v1beta/models/{model}:streamGenerateContent` (`?alt=sse`), `POST /gemini/v1beta/models/{model}:countTokens`, `GET /gemini/v1beta/models`. Also `GET /health`. The OpenAI Responses API is deferred (P10). |
| D3 | Translation scope | All 6 cells (3 dialects × 2 providers). The 2 native cells are built first (P4), then the 4 translated cells (P5). Every mapping rule is written only from P0 specs and captures. **Strict by default:** an input feature the target cannot carry returns HTTP 400 `unsupported_feature`, naming the feature. **Lossy only on opt-in** through the request header `x-router-lossy: 1`; the response then carries `x-router-dropped: <comma-separated features>`. |
| D4 | Subscription providers | Both are enabled in this machine's `config/router.yaml` with `acknowledgeTermsRisk: true` (the user accepted the ToS risk on 2026-10-06; the verbatim terms are in research §3). The code default is disabled: a provider without the flag fails to start with a named error. On 429 / `RESOURCE_EXHAUSTED` / quota, the router **passes the error back** in the client's dialect with `retry-after`. It **never** switches account automatically. The account is chosen manually with `inference-router account use <id>`. |
| D5 | Credentials | The router keeps its **own** stores under `~/.local/share/inference-router/` and runs its own logins. It does not share `~/.claude/.credentials.json`, `antigravity-pool.json`, or opencode `auth.json` by default. Whether a shared mode is safe is decided only from the P0-E4 measurement. |
| D6 | Local security | Binds `127.0.0.1` only. Every route except `GET /health` needs the router token: 32 random bytes, base64url, file `~/.local/share/inference-router/token`, printed by `inference-router token`, compared in constant time (`crypto.timingSafeEqual`). Accepted carriers, so stock SDKs work unchanged: `authorization: Bearer <t>` (OpenAI), `x-api-key: <t>` (Anthropic), `x-goog-api-key: <t>` or `?key=<t>` (Gemini). A missing or wrong token returns 401 in the requesting dialect's error shape. The port is fixed in config; the default value is chosen by P0-E5. |
| D7 | HTTP server | `node:http`, the same server both existing relays use, so their tested request and stream code ports over without a rewrite. |
| D8 | Model addressing | `<provider>/<model>`, e.g. `claude/claude-opus-4-8` or `antigravity/<wire-id>`. Optional bare-name aliases go in `config/router.yaml`. A bare name with no alias returns 404 `unknown_model`. On Gemini routes the `{model}` path segment carries the same id, URL-encoded. |
| D9 | Repo hosting | Local git from the first commit. The private GitHub repo `mavasbel/inference-router` is created and pushed at the end of P1. |

### 0.1 Wire laws carried over verbatim (they must not regress)

| Law | Source |
|---|---|
| Antigravity `thinkingConfig.thinkingBudget` = the catalog's advertised `thinkingBudget`, verbatim (catalog-exact) | project memory #932; `ModelCatalogService.ts:84-99` |
| Antigravity int64 `sessionId` handled as a decimal string end to end, never through a `Number()` round-trip | memory #935; `TrajectoryStateService.ts:64-73` |
| Claude `thinking` rebuilt from scratch, so `thinking.adaptive.block_binding` and any other extra key are stripped | memory #939; `RequestTransformService.ts:256-281` |
| Claude prefill guard: drop trailing assistant/tool messages; rebuild or drop orphan tool results (L1/L2/L3) | `RequestTransformService.ts:86-166` |
| Antigravity trajectory labels, requestId format, and step counter | `TrajectoryStateService.ts:76-204` |
| Antigravity `thoughtSignature` capture/replay; Gemini calls without a signature are dropped together with their results | `RequestTransformService.ts:186-277` |
| Claude identity envelope: billing block, Agent-SDK identity block, `metadata.user_id` JSON, `context_management`, per-model betas | `RequestTransformService.ts:187-298`, `ModelEnvelope.ts:49-190` |

## 1. Provider × dialect matrix (v2)

> Superseded by v4 (2026-10-11): 4 dialects × 3 providers, see [completion plan §4](2026-10-11-22-11-completion-plan.md).

| Inbound dialect \ Provider | `claude` (Anthropic Messages upstream) | `antigravity` (Gemini envelope upstream; serves Gemini, Claude and gpt-oss models) |
|---|---|---|
| **Anthropic Messages** | **NATIVE** — passthrough through the claude envelope and guards; true SSE streaming (P4) | TRANSLATED (P5) |
| **OpenAI Chat Completions** | TRANSLATED (P5) | TRANSLATED (P5) — the logic exists in the plugin relay (`OpenAICompatRelayAdapter.ts`) and is ported, not rewritten |
| **Gemini generateContent** | TRANSLATED (P5) | **NEAR-NATIVE** — the Gemini request is wrapped in the outer envelope with trajectory and signatures (P4) |

## 2. Architecture (AGENTS.md §4: hexagonal, split inbound/outbound, SOLID, IoC, DI)

```
inference-router/                       (Bun workspace)
  packages/
    core/                               @inference-router/core — domain + ports, stdlib only
      src/domain/canonical/             CanonicalRequest, CanonicalMessage, Part (text | image |
                                        document | tool_call | tool_result |
                                        thinking{text, signature, origin}), ToolSpec, ToolChoice,
                                        GenerationParams, ThinkingIntent, CanonicalEvent union
                                        (message_start, block_start, text_delta, thinking_delta,
                                        tool_args_delta, block_stop, usage, finish{reason}, error)
      src/domain/errors/                RouterError tree: UnsupportedFeature, UnknownModel,
                                        Unauthorized, UpstreamError{status, retryAfter},
                                        QuotaExhausted, AuthExpired, ProviderDisabled
      src/domain/services/              ModelAddress parser, FeatureSupport check,
                                        usage normalisation
      src/ports/inbound/                ChatPort.stream(req): AsyncIterable<CanonicalEvent>;
                                        CountTokensPort; ListModelsPort; PassthroughPort
      src/ports/outbound/               ProviderPort (abstract base: id, capabilities(), stream(),
                                        count(), models(), passthrough?(dialect, raw));
                                        CredentialStorePort; TokenRefresherPort; LockPort;
                                        ClockPort; RandomPort; LoggerPort; HttpTransportPort
                                        (streaming body)
    provider-claude/                    @inference-router/provider-claude — adapters/outbound:
                                        ClaudeSubscriptionProvider (PKCE paste-code OAuth, refresh
                                        under a lock, identity, envelope, guards, betas, model
                                        catalog with a 24 h cache and static fallback)
    provider-antigravity/               @inference-router/provider-antigravity — adapters/outbound:
                                        AntigravityProvider (Google loopback OAuth, account pool,
                                        project resolution, trajectory, signatures, envelope,
                                        catalog, quota)
    dialect-anthropic/                  adapters/inbound: Anthropic Messages codec
                                        (wire <-> canonical, SSE event encoder/decoder)
    dialect-openai/                     adapters/inbound: Chat Completions codec
    dialect-gemini/                     adapters/inbound: generateContent codec
  apps/router/
    src/application/                    RouteChatService, RouteCountService, ListModelsService,
                                        PassthroughService, AccountAdminService (implement the
                                        inbound ports; depend on ports only)
    src/adapters/inbound/http/          HttpServerAdapter (node:http), AuthGuard, route table,
                                        dialect dispatch, dialect-shaped error writer
    src/adapters/inbound/cli/           serve | login <provider> | account list | account use <id>
                                        | token | status | models | quota
    src/adapters/outbound/              FileCredentialStore (atomic tmp+rename), FileLock (O_EXCL +
                                        stale timeout), FileLogger, NodeHttpTransport,
                                        SystemClock/Random, YamlConfigLoader
    src/composition/container.ts        the ONLY place adapters are constructed
  config/router.yaml                    port, providers{enabled, acknowledgeTermsRisk}, aliases
  docs/{plans,sessions,research,issues,reference,temp}/
```

- **Abstraction trees.** `ProviderPort` is an abstract class that every provider extends. `DialectCodec<Wire>` is the abstract base of the 3 codecs. Shared HTTP/SSE plumbing lives in abstract bases (`SseEncoder`, `SseDecoder`), never in duplicated code.
- **IoC.** Every constructor argument and return type is a port or abstraction, never a concrete class. This fixes research §1.2: the claude relay depends on the concrete `RefreshSessionUseCase`.
- **Dependency law**, enforced by an AST architecture test that is a release gate:
  - direction is adapters → ports → domain only;
  - `adapters/inbound` never imports `adapters/outbound`, and vice versa;
  - `packages/core` imports only the stdlib;
  - only `composition/container.ts` constructs adapters;
  - no host (opencode) import anywhere.
  - The path matching is tested against the real aliased paths, which fixes research §6.7: the antigravity check `startsWith('adapters/')` never fires.

**Request flows**
- **Native cell:** HTTP → AuthGuard → route → PassthroughService → `provider.passthrough(dialect, raw)`. The provider applies its own envelope and guards, and the upstream body is **piped** back to the client as it arrives. There is no canonical round-trip.
- **Translated cell:** HTTP → AuthGuard → codec decode → CanonicalRequest → FeatureSupport(provider capabilities), which returns 400 or, in lossy mode, a drop list → `provider.stream` → CanonicalEvent stream → codec encode → SSE or JSON.
- **Errors:** every `RouterError` is written in the requesting dialect's error shape, with the shapes taken from the P0-E1 specs.

## 3. Tests and gates (AGENTS.md §4)

- **Layout.** Every package and the app has `tests/{unit,component,live,e2e}`.
- **Coverage.** Babel + istanbul, the toolchain already proven in `opencode-cheaper-inference-auth` (`scripts/report-coverage.ts:22-27`). The gate is **100% lines / statements / functions / branches** for unit and for e2e, plus a merged report, and it fails below 100. Bun's native `coverageThreshold` is not used: per the Bun 1.4.2 docs (Context7 `/oven-sh/bun/bun-v1.4.2`) it enforces only lines and functions, and accepts `statements` without enforcing it.
- **Real e2e coverage.** The e2e build is instrumented and writes `__coverage__` on process exit. The gate fails if the file is missing or empty. This fixes the cheaper-inference-auth defect where e2e coverage was always empty.
- **E2E clients** are the official SDKs: `@anthropic-ai/sdk`, `openai`, `@google/genai`. They run against the real router daemon process, with local fake upstreams that replay the P0 captures. Exact numeric versions are read from the npm registry in P1 and recorded.
- **Live tier** (`INFERENCE_ROUTER_LIVE=1`): the real daemon against the real accounts. For each of the 6 cells it sends minimal prompts covering stream and non-stream, a tool loop, and thinking where the model supports it.
- **Teardown safety.** Every recursive delete goes through `removeTemporary`, which refuses any path outside `os.tmpdir()` (memory #1059).
- **Gate:** `bun run verify` = typecheck → arch test → unit + component → unit coverage 100 → build → e2e + e2e coverage 100 → merged coverage 100 → doc/diagram lint.
- **Pins** (no `latest`, no ranges): Bun 1.4.2 (measured installed), TypeScript 5.9.3, `@types/bun` 1.4.2, `@babel/core` 8.0.1, `@babel/plugin-transform-typescript` 8.0.1, `babel-plugin-istanbul` 8.0.0, `istanbul-lib-coverage` 3.2.2, `istanbul-lib-report` 3.0.1, `istanbul-reports` 3.2.0. The SDK versions and the YAML parser version are pinned in P1 from the registry.

## 4. Phases

### P0 — Evidence (no product code). Output: `docs/reference/*` and `tests/fixtures/captures/*`
- **E1 Specs.** Fetch the official references into `docs/reference/`:
  - Anthropic Messages: request, streaming events, errors, count_tokens, models;
  - OpenAI Chat Completions: request, chunk stream, tool_calls, usage, errors, models;
  - Gemini API: generateContent, streamGenerateContent SSE, countTokens, models.list, error shape.
- **E2 Captures.** Record real native streaming exchanges, with secrets redacted:
  - Claude subscription, through the existing plugin wire code: plain text, a tool call plus its tool-result turn, thinking.
  - Antigravity with a Gemini model and with a Claude-via-Antigravity model: the same three scenarios.
- **E3 Fidelity matrix.** Measure each provider's acceptance of each canonical feature: images, documents, tool_choice modes, parallel tool calls, thinking/thought signatures, stop sequences, temperature/top_p/top_k, system placement, and cache_control. The result is `docs/reference/<ts>-fidelity-matrix.md`, the only source for the FeatureSupport tables.
- **E4 Refresh-token rotation.** On the router's own fresh logins only, refresh once, then test whether the old refresh token still works, for both Claude and Google OAuth. This decides D5's shared mode.
- **E5 Default port.** Choose it by `netstat` on this machine. (4141, measured on Windows 2026-10-06; re-measured free on Linux 2026-10-10 with `ss -ltn`.)
- **Exit:** all specs and captures are filed, and the matrix has no UNVERIFIED cell for the 2 native cells.

### P1 — Scaffold
- Create the repo directory and `git init` (done 2026-10-06 on Windows; moved to Linux 2026-10-10, see v3.1).
- Set up the workspace, package and app skeletons, tsconfig project references, pins, the Babel/istanbul coverage scripts, the AST arch test, `removeTemporary`, and `verify`.
- Write AGENTS.md (laws, including §0.1), README, `docs/architecture.drawio` plus mermaid diagrams, and `config/router.yaml`.
- Copy this plan and the research into the repo's `docs/`.
- Create the private GitHub repo `mavasbel/inference-router` and push.

### P2 — Core domain and ports
- Build the canonical model, error tree, ModelAddress, FeatureSupport, usage normalisation, and the abstract `ProviderPort`, `DialectCodec`, `SseEncoder` and `SseDecoder`. 100% unit coverage.

### P3 — Provider packages (extraction with provenance)
- **Provenance.** `PROVENANCE.md` per package records source repo, commit SHA and the file-by-file mapping.
- **Defects fixed during extraction** (research §6):
  1. Claude: true streaming. Pipe the upstream body instead of `await res.text()` (`AnthropicApiClientAdapter.ts:45`).
  2. Claude: single-flight refresh in process, plus a cross-process `LockPort` (`RefreshSessionUseCase.ts:30-49`).
  3. Claude: no budget clamp. The value passes through, per claude AGENTS §8 (`RequestTransformService.ts:273`).
  4. Claude: honour host `anthropic-beta`, merged with the per-model list, on the native cell (`AnthropicRelayAdapter.ts:100-103`). The exact merge rule comes from the P0 captures.
  5. Antigravity: proactive refresh on the chat path (`StreamChatUseCase.ts:85`).
  6. Antigravity: map 429/`RESOURCE_EXHAUSTED` → `QuotaExhausted` with `retry-after`, and never rotate automatically (D4).
- **Parity test.** For the same fixture input, the package's outbound request (method, URL, headers, body) equals the plugin's outbound request after masking random ids. A mismatch is a defect, not a tolerance, except for the intentional fixes 1–6, each listed explicitly in the test.
- **CLI logins:** `inference-router login antigravity` (Google loopback) and `inference-router login claude` (PKCE with the browser loopback proven in P0-E6; paste-code only with `--manual`). Both write only to the router's own stores (D5).

### P4 — Daemon and the 2 native cells
- HttpServerAdapter, AuthGuard (D6), route table (D2), model addressing (D8), `/health`, graceful stop on SIGINT/SIGTERM.
- Cells: Anthropic → `claude` (passthrough, truly streamed); Gemini → `antigravity` (near-native).
- Models endpoints in all 3 dialects, from each provider's own catalog.
- Component tests, plus e2e with the official SDKs against the daemon.

### P5 — The 4 translated cells
- Decode/encode codecs per dialect, provider canonical mappers, FeatureSupport strict/lossy (D3), finish-reason and usage maps. Every mapping cites a P0 spec or capture.
- OpenAI → `antigravity` is ported from `OpenAICompatRelayAdapter.ts` onto the codec and canonical model.
- Thinking `signature` / `thoughtSignature` are bound to the provider that issued them. Across providers they are `unsupported_feature`, or dropped and reported in lossy mode.
- E2E covers all 6 cells × {stream, non-stream} × {text, tool loop}, and the error paths (401, 400 unsupported_feature, 404 unknown_model, upstream 429).

### P6 — Live validation
- Run the live tier against the real accounts for all 6 cells.
- Record in `docs/reference/<ts>-live-results.md`: pass/fail per cell, time to first token, and proof of incremental streaming (inter-chunk timestamps).

### P7 — Documentation sweep
- README, AGENTS.md, plan status.
- Complete diagrams: component, sequences for the native and translated flows, the matrix.
- Client how-to: Anthropic, OpenAI and Gemini SDKs; Claude Code via `ANTHROPIC_BASE_URL`; any OpenAI-compatible tool.
- Every statement is checked against the code and the measured results.

### P8 — Plugin migration (separate approval gate, one plugin at a time)
- `opencode-claude-auth` and `opencode-antigravity-auth` keep their host adapters, consume the packages, and lose their duplicated wire code.
- Each passes its own full gate and the deploy flow in memories #933 and #1281.
- `opencode-cheaper-inference-auth` is not migrated: no package corresponds to it in v2.
- Optional R5 (plugins point OpenCode at the daemon) is decided only at this gate.

### P9 — Stabilise
- Full `verify`, a live re-run, and the hindsight initiative update.

### P10 — Optional (own plan each)

> Superseded by v4 (2026-10-11): the Responses dialect moved into P4.5/P5; API-key providers stay excluded, so P10 is empty.
- OpenAI Responses API dialect.
- API-key providers (Anthropic key, OpenAI-compatible/Cheaper, Gemini key), with the `catalog` reconciliation package.

## 5. Rollback and safety
- Until P8, nothing is modified outside the repo (`/home/mavasbel/Dev/repos/inference-router`), the router's data directory and the scratch directory `/tmp/opencode`. The global OpenCode config, the plugin repos and the deployed plugin files are untouched (memory #931).
- Router credentials live only in `~/.local/share/inference-router/`. Rollback means deleting that directory and the repo.
- Live calls run only in P0-E2/E3/E4 and P6, with minimal prompts.
- P0-E4 can invalidate a refresh token, so it runs only on the router's own fresh login, never on Claude Code's or the plugins' credentials.

## 6. Open item before lock
- **C1.** "No API keys" is read as excluding **all** API-key providers, including Cheaper Inference. As a result the OpenAI dialect has no native cell, and both of its cells are translated. Confirm, or keep Cheaper as an OpenAI-native provider (which would restore `provider-openai-compat` and a 3rd column).
