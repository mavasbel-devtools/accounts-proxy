# Research — local multi-dialect LLM router built from the mavasbel opencode auth plugins

Date: 2026-10-05 20:07 · Status: RESEARCH (no plan locked, no code written)
Scope: `AIML/tools/opencode-antigravity-auth` (HEAD 5c6f7c2), `opencode-claude-auth` (HEAD 6292741),
`opencode-cheaper-inference-auth` (HEAD f2c5e23). All three were read in full (src/, AGENTS.md, package.json, test/).
Every code claim below carries `file:line` from that read. Anything not verified is labelled **UNVERIFIED**.
Note 2026-10-10: since the Linux migration the plugin repos are `/home/mavasbel/Dev/repos/opencode/<repo>`; the commits cited here are present there.

---

## 1. What each plugin actually is

### 1.1 opencode-antigravity-auth — Google Antigravity (Cloud Code Assist) backend

| Concern | Fact | Evidence |
|---|---|---|
| OAuth | Google OAuth, Antigravity IDE 2.5.5 client id/secret hardcoded; loopback callback on ephemeral `127.0.0.1` port; no PKCE | `infrastructure/config/PluginConfig.ts:1-15`, `GoogleOAuthClientAdapter.ts:17-54`, `LoopbackCallbackServerAdapter.ts:17-63` |
| Credentials | Own multi-account pool `~/.local/share/opencode/antigravity-pool.json` (`ANTIGRAVITY_POOL_PATH`), mirror into opencode `auth.json` key `antigravity` | `OpencodeCredentialStoreAdapter.ts:42-115`, `domain/entities/Account.ts:1-22` |
| Refresh | ≤120 s → refresh; 401 → rotate+retry once. Chat path uses bare `loadActive` (no proactive refresh) — contradicts its own AGENTS "token lifecycle law" | `RefreshSessionUseCase.ts:45-97,157-166`, `StreamChatUseCase.ts:85,114-118` |
| Upstream | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`, UA `antigravity/ide/2.5.5 …`; envelope `{project, requestId, request, model, userAgent:'antigravity', requestType:'agent'}` | `AntigravityApiClientAdapter.ts:62-112`, `PluginConfig.ts:18-26` |
| Inner body | Gemini `GenerateContentRequest` shape (`contents`, `systemInstruction`, `tools[functionDeclarations]`, `toolConfig VALIDATED`, `labels`, `generationConfig.thinkingConfig`, `sessionId`) | `RequestTransformService.ts:24-30,151-164` |
| Stateful wire | Trajectory labels/requestId (`TrajectoryStateService`), int64 sessionId as decimal string, Gemini `thoughtSignature` cache (2000 entries, file-backed) | `TrajectoryStateService.ts:64-204`, `SignatureStoreAdapter.ts:6-73`, `RequestTransformService.ts:186-277` |
| Models | Live `fetchAvailableModels`; catalog includes Gemini family **and Claude (`claude-{opus,sonnet}-5-5-*`) and `gpt-oss-120b-medium`** served through Antigravity | `ModelCatalogService.ts:31-145`, `test/live/model-matrix.test.ts:36-81` |
| Quota | `v1internal:retrieveUserQuotaSummary` | `AntigravityApiClientAdapter.ts:58-60`, `QuotaService.ts` |
| **Existing relay** | `node:http` on `127.0.0.1:<ephemeral>`: `GET /v1/models`, `GET /v1/usage`, `POST /v1/chat/completions` — **OpenAI Chat Completions in (stream + non-stream, tool_calls, reasoning_content, usage) → Gemini envelope out** | `inbound/relay/OpenAICompatRelayAdapter.ts:55-285` |
| Gaps | No 429/RESOURCE_EXHAUSTED handling (`QuotaExhaustedError` never thrown), no account failover (`withCooldown` unused), no local auth on the relay socket, no coverage threshold enforced | `ProtocolError.ts:12-17`, `AccountPoolService.ts:23-53`, relay `:83-101`, `package.json:7-18` |

### 1.2 opencode-claude-auth — Anthropic Claude subscription (Claude-Code-style OAuth)

| Concern | Fact | Evidence |
|---|---|---|
| OAuth | PKCE S256, paste-code flow, client id `9d1c250a-…`, authorize `claude.com/cai/oauth/authorize`, token `platform.claude.com/v1/oauth/token` | `RequestTransformService.ts:52-58`, `ClaudeOAuthClientAdapter.ts:19-113`, `LoginUseCase.ts:36-54` |
| Credentials | Reads/writes Claude Code's own `~/.claude/.credentials.json` (`claudeAiOauth`); fallback opencode `auth.json` | `ClaudeCredentialStoreAdapter.ts:15-145` |
| Refresh | ≤120 s → refresh, persisted; **no mutex** (concurrent requests may race refreshes) | `RefreshSessionUseCase.ts:30-49`, `ClaudeCredential.ts:33-35` |
| Upstream | `https://api.anthropic.com/v1/messages?beta=true` (+ `count_tokens`); Claude-Code impersonation headers (`user-agent claude-cli/2.1.280.b1a`, `x-app: cli`, `x-stainless-*`, per-model `anthropic-beta`) | `RequestTransformService.ts:38-42,187-252` |
| Body envelope | prepends billing block + Agent-SDK identity system block; `metadata.user_id` JSON; rebuilds `thinking` (strips `block_binding`), forces `context_management clear_thinking_20251015`; **clamps budget ≥1024 (contradicts AGENTS §8)** | `RequestTransformService.ts:193-298` |
| Normalisation | L1/L2/L3 guards: drop trailing assistant (no prefill), rebuild orphan tool results | `RequestTransformService.ts:86-166` |
| Models | `GET /v1/models` paged, 24 h cache, static fallback of 10 ids; `ModelEnvelope` per-model betas/max_tokens/thinking | `AnthropicModelsApiAdapter.ts`, `RefreshModelCatalogUseCase.ts:26-68`, `ModelEnvelope.ts:49-190` |
| **Existing relay** | `node:http` on `127.0.0.1:<ephemeral>`: `GET /health`, `POST /v1/messages`, `POST /v1/messages/count_tokens` — **Anthropic Messages in → Anthropic Messages out** | `inbound/relay/AnthropicRelayAdapter.ts:50-154` |
| Gaps | **Relay does not stream** — full upstream body buffered (`await res.text()`) then sent at once; host `anthropic-beta` dropped; no retry; no local auth; no coverage threshold enforced | `AnthropicApiClientAdapter.ts:45`, relay `:54-55,100-103` |

### 1.3 opencode-cheaper-inference-auth — API-key OpenAI-compatible provider

| Concern | Fact | Evidence |
|---|---|---|
| Upstream | `https://api.cheaperinference.com/v1` OpenAI-compatible; Bearer API key; no OAuth | `PluginConfig.ts:1-11`, `CheaperInferenceHttpAdapter.ts:20` |
| Role | **No request proxying at all.** Discovers `/v1/models` + `/public/models`, reconciles metadata (OpenCode models.dev, OpenRouter, LiteLLM) by exact id/alias, registers `@ai-sdk/openai-compatible` provider | `OpenCodeLegacyPluginAdapter.ts:21-32`, `OpenCodeV2PluginAdapter.ts:49-70`, `MetadataReconciliationService.ts:17-179`, `ModelMatchingService.ts:11-25` |
| Reusable value | The metadata-reconciliation engine (limits, pricing, capabilities, provenance per field) is provider-agnostic and the strongest catalog component of the three | `domain/services/*` |
| Quality | Only repo with an enforced 100% (lines/statements/functions/branches) gate | `scripts/report-coverage.ts:22-27` |

### 1.4 Host coupling (common to all three)

Host-independent: all of `domain/`, `application/`, every outbound adapter, **and both relays**.
Host-coupled: only `OpenCodeLegacy*Adapter`, `OpenCodeV2*Adapter`, TUI adapters, `main/*`, and the opencode `auth.json`
fallback/mirror paths. → The parts a router needs are already separable without rewriting them.

---

## 2. Answer to the question — feasible? Yes, and ~half of it already exists

A router is: **inbound dialect adapters** (Anthropic Messages, OpenAI Chat Completions, Gemini `generateContent`)
→ domain routing + (when dialects differ) translation → **outbound provider adapters** (Claude subscription,
Antigravity, Cheaper/any OpenAI-compatible key provider).

What already exists: 2 of the 9 dialect×provider cells (Anthropic→Claude native; OpenAI→Antigravity), the complete
auth/refresh/credential/identity/catalog machinery for all three providers, and the hard-won wire laws
(catalog-exact `thinkingBudget`, `block_binding` strip, prefill guard, int64 sessionId as string, thoughtSignature replay).

### 2.1 Dialect × provider matrix

| Inbound \ Provider | Claude (Anthropic native) | Antigravity (Gemini envelope; serves Gemini + Claude + gpt-oss) | Cheaper (OpenAI native) |
|---|---|---|---|
| **Anthropic Messages** | EXISTS (needs real streaming) | translate | translate |
| **OpenAI Chat Completions** | translate | EXISTS | pass-through (+key injection) |
| **Gemini generateContent** | translate | near-native (wrap envelope + trajectory + signatures) | translate |

Native/near-native cells are lossless. Translated cells are lossy by construction; known losses to be measured:
Anthropic `cache_control`, thinking-block `signature` (provider-bound, cannot cross providers), server tools
(web_search etc.), PDF/document blocks, OpenAI `n>1`/`logprobs`/`response_format` semantics, Gemini `safetySettings`.
Exact behaviour of each per provider is **UNVERIFIED** until a Phase-0 capture/probe establishes it (same
ASSUME-NOTHING law used for messenger-mcp).

---

## 3. Policy / account risk — verified at source 2026-10-05

* **Google Antigravity Additional Terms** (https://antigravity.google/terms, fetched 2026-10-05): *"Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this
  Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."*
* **Anthropic — Claude Code legal & compliance** (https://code.claude.com/docs/en/legal-and-compliance, fetched
  2026-10-05): OAuth *"is designed to support ordinary use of Claude Code and other native Anthropic applications"*;
  third-party developers may not *"route requests through Free, Pro, or Max plan credentials on behalf of their users"*;
  *"Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."*

Implication: the existing antigravity and claude plugins already operate outside these terms; a router does not change
the category but **enlarges the exposure** (any client, more traffic, more fingerprint surface). Cheaper Inference is a
plain API key — no such issue. This is a user risk decision, not a technical blocker.

---

## 4. Prior art (verified via GitHub API 2026-10-05)

| Project | Lang | Stars | What it does |
|---|---|---|---|
| router-for-me/CLIProxyAPI | Go | 54,246 | Wraps Antigravity, Codex, Claude Code, … as OpenAI/Gemini/Claude/Codex-compatible API |
| starhunt/star-cliproxy | TS | 41 | OpenAI+Anthropic-compatible proxy for Claude Code, Codex, Antigravity, Grok CLI |
| balakumardev/antigravity-reverseproxy-api | JS | 6 | Anthropic+OpenAI endpoints backed by Antigravity Cloud Code |

Not audited (code, test quality, wire fidelity UNVERIFIED). They prove the concept; none satisfy the hex/test laws.

---

## 5. Reuse strategies

| Id | Strategy | Pros | Cons |
|---|---|---|---|
| R1 | **Bun workspace monorepo**: extract each plugin's host-independent layers into `provider-claude`, `provider-antigravity`, `provider-openai-compat` (+ `catalog-reconciliation`) packages; router + the 3 plugins consume them | Single source of truth for wire laws; plugins shrink to host adapters | Refactor touches 3 shipped repos, their coverage gates and installers |
| R2 | New `llm-router` repo depending on the 3 plugin repos **pinned by git SHA**, importing via new `exports` subpaths | Small change to plugins | Router couples to plugin internals; versioning friction |
| R3 | Copy (vendor) the code into the router | Fastest start | Two copies of every wire law → guaranteed drift |
| R4 | Adopt CLIProxyAPI unchanged | Zero build | Discards our code/laws; Go; not hex; unaudited |
| R5 | R1 + plugins stop embedding relays and point OpenCode at the running router daemon | One relay for everything | OpenCode depends on a daemon being up |

## 6. Defects in the bases that the router must fix (regardless of strategy)

1. claude relay buffers the whole response — must become true SSE streaming (`AnthropicApiClientAdapter.ts:45`).
2. claude refresh has no single-flight lock (`RefreshSessionUseCase.ts:30-49`).
3. claude budget clamp ≥1024 contradicts its AGENTS §8 (`RequestTransformService.ts:273`).
4. antigravity chat path skips proactive refresh (`StreamChatUseCase.ts:85`).
5. antigravity: no 429/quota handling, no multi-account failover (`withCooldown` dead code).
6. Both relays: no local authentication (any local process can spend the subscription).
7. antigravity + claude: no enforced coverage threshold; arch tests do not enforce inbound/outbound adapter split.
8. Doc drift: antigravity AGENTS wire law 13 still says gemini → -1 (code is catalog-exact).
