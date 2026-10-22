# Plan v4: completion (Phase H → P4.5 → P5 → P6 → P7 → P8 → P9)

Date: 2026-10-11 22:11 · Status: **APPROVED 2026-10-11 ("Could we include the opencode extra headers and proceed? Could
we continue until all done?") — IN EXECUTION**.
Parent plan: [2026-10-06-00-23-inference-router-plan.md](2026-10-06-00-23-inference-router-plan.md) (extended by its
"Changes v3.1 → v4" section; nothing in it is replaced). Earlier plans: [P0-LIVE](2026-10-07-01-23-p0-live-gate-plan.md),
[continuation](2026-10-10-18-45-continuation-plan.md), [P4](2026-10-10-19-00-p4-daemon-native-cells-plan.md).

Plan rule (user, 2026-10-11): plans are never replaced, only extended. New phases, amendments and decisions are new
sections or new dated files that link back; earlier decisions, status lines and execution records stay intact and are
marked superseded where they no longer apply.

## 0. Decisions (approved 2026-10-11)

| # | Decision | Answer |
|---|---|---|
| H-Q1 | Shared `OAuthSessionBase` in core outbound ports, extended by all three providers | yes |
| H-Q2 | Claude: on an upstream 401, renew once and retry, only before any byte reaches the client (deviation from the plugin, which has no retry) | yes |
| H-Q3 | Token-endpoint calls get a 30 s deadline, below the 60 s lock staleness | yes |
| H-Q4 | A transient renewal failure (5xx / network) falls back to the stored token while it has not actually expired | yes |
| H-Q5 | New error 502 `upstream_unreachable` for DNS / refused / reset failures | yes |
| H-Q6 | A rejected refresh (400/401) marks the account `needsLogin`; requests fail fast until a new login | yes |
| O1 | OpenAI sign-in: the official "Sign in with ChatGPT" plan usage flow only (not the legacy Codex client) | yes |
| O2 | Provider id `openai` | yes |
| O3 | Repo visibility vs. the docs' "open-source and locally hosted apps" scope | **not answered.** D9 (private) stays in force; asked again at the OpenAI sign-in stop (§7) |
| O4 | `agent_name_hint` = `inference-router` | yes |
| O5 | OpenAI Responses becomes a 4th inbound dialect (native to `openai`, translated to the others) | yes |
| O6 | `openai` needs `acknowledgeTermsRisk: true` like the others | yes |
| O7 | Documented unsupported Responses fields: 400 `unsupported_feature` by default; dropped only with `x-router-lossy: 1` | yes |
| O8 | Non-streamed Responses requests: the upstream stream is aggregated into one `response` object | yes |
| O9 | **Changed by the user:** send the opencode extra headers (`session-id`, `thread-id`, `x-client-request-id`, as `chatgpt.ts:276-279` does) | yes, included |
| O10 | OpenAI refresh rotation from the official token reference plus one live renewal in P4.5 step 2 | yes |
| O11 | Order H → P4.5 → P5 → P6 → P7 → P8 → P9, continuous except at the stops in §7 | yes |
| O12 | P8 is covered by this approval up to commit; installing into OpenCode stays the user's step | yes |

## 1. Robustness review of the existing providers (2026-10-11, code at `e8fdc44`)

Holds today: proactive renewal 2 min before expiry; in-process single flight; cross-process lock with re-read; rotated
refresh token stored, previous kept when none issued; Antigravity 401 → one force-rotation before anything streamed;
Antigravity location-gate retries; 429 with `retry-after` surfaced; atomic 0600 stores; stale locks reclaimed after 60 s.

| # | Gap | Evidence |
|---|---|---|
| H1 | Lost update: `login` and `account use` save the pool without the lock; renewal reads the pool before the token call and saves after it | `login-service.ts:39`, `account-services.ts:22-23`, `claude-session.ts:41-44`, `antigravity-session.ts:52-57` |
| H2 | Lock staleness (60 s) shorter than an unbounded token call → a second process can spend the same refresh token | `file-lock.ts:19`, `claude-oauth-client.ts:86`, `google-oauth-client.ts:93` |
| H3 | Claude has no 401 renew-and-retry (plugin parity) | `claude-subscription-provider.ts:100` |
| H4 | A transient renewal failure fails a request whose token is still valid | `claude-session.ts:43`, `antigravity-session.ts:54` |
| H5 | DNS / refused / reset errors surface as 500 `internal_error` | `fetch-transport.ts:40,55`, `route-handler.ts:71` |
| H6 | A dead refresh token is retried on every request | `claude-oauth-client.ts:88-90`, `google-oauth-client.ts:100` |
| H7 | Refresh-token rotation unmeasured for both providers (E4) | P0-LIVE plan §5 |

## 2. Phase H — harden the existing providers

1. **H-a** `OAuthSessionBase` (abstract, `packages/core/src/ports/outbound/session.ts`): proactive renewal, in-process
   single flight, cross-process renewal lock, `forceRenew(seen)` that reuses a token renewed by someone else, H4
   fallback, H6 marker. `ClaudeSession`, `AntigravitySession` and the later OpenAI session extend it.
2. **H-b** `CredentialStorePort.update(provider, change)`: read → change → write under a per-provider store lock.
   Renewal writes through it (re-reading after the token call); `login` and `account use` too. Lock order is always
   renewal lock → store lock.
3. **H-c** token-endpoint deadline 30 s (< 60 s staleness), a design value; AGENTS.md records the invariant.
4. **H-d** Claude 401 → renew once → retry, only before the response is forwarded.
5. **H-e** transient renewal failure with a still-valid stored token → use it, log a warning.
6. **H-f** `UpstreamUnreachableError` (502 `upstream_unreachable`) from the transport.
7. **H-g** `needsLogin` on the account after a rejected refresh; fast 401; cleared by login; shown by `account list`
   and `status`.
8. **H-h** E4 live (user present): renew once per provider on the router's own account, try the old refresh token once;
   result appended to the P0-LIVE plan ("E4 amendment") and the findings; settles D5.
9. Tests: unit and component per fix; e2e with two real router processes (`account use` during a delayed renewal, hung
   token endpoint vs. 30 s, Claude 401 → renew → 200, 5xx renewal with a valid token, closed port → 502, dead login →
   `needsLogin` → fast 401 → login). 100% in every tier; `verify` PASS.
10. Docs (AGENTS.md rules, README error table, this plan's record), commit, push.

## 3. Phase P4.5 — provider `openai` (Sign in with ChatGPT plan usage) and the native Responses cell

1. **Evidence.** Official pages into `docs/reference/specs/` with URL and fetch date: plan-usage overview, sign-in,
   accounts and sessions, models and inference, Codex app-server, self-hosted VMs, token reference, errors and
   recovery, preview limitations, UI/UX guidelines; the Responses API reference (request, streaming events, response
   object, errors). Vendored byte-identical opencode files at `35ef229454` (`packages/core/src/plugin/provider/chatgpt.ts`,
   `packages/core/src/session/to-session-error.ts`, `packages/core/src/oauth/page.ts`, `packages/core/src/session/affinity.ts`)
   with `PROVENANCE.md`. A rules document mapping each rule to its source.
2. **Live probe (user signs in once).** Recorded and redacted: sign-in, model list, one streamed request, each
   documented unsupported field once, one renewal plus one reuse attempt of the old refresh token, the
   unsupported-field error shape. Output: OpenAI findings document.
3. **Build.** `packages/provider-openai` (domain: authorize parameters, ID-token checks, limits table, error-code map,
   model filter, stream → response aggregation; adapters: OAuth client with dynamic registration and a persisted
   `ext_agent_host_id`, 127.0.0.1 loopback `/auth/callback`, RS256 ID-token verification with `node:crypto` against
   `/.well-known/jwks.json`, session extending H-a, catalog live → cache → built-in `chatgpt.ts:30-47`, provider with
   the opencode headers `session-id`, `thread-id`, `x-client-request-id`). `dialect-openai`: `POST /openai/v1/responses`
   (limits check; `store:false`, `stream:true` forced upstream; aggregation for non-streamed clients). CLI `login openai`
   (`--manual` only if the self-hosted VMs page documents one), `account`, `models`, `status`. Config `openai` with
   `acknowledgeTermsRisk`; seams `INFERENCE_ROUTER_TEST_UPSTREAM_{OPENAI_API,OPENAI_AUTH}`.
4. **Tests.** Unit, component, parity with the vendored `chatgpt.ts` (authorize URL, exchange body, refresh body); e2e
   with the official `openai` SDK `responses.create` streamed and not, fake-browser login, plan-usage errors, 429,
   rotation. 100% in every tier; live smoke through the daemon.
5. **Docs**, commit, push.

## 4. Phase P5 — the 9 translated cells (matrix v4)

| Inbound \ provider | claude | antigravity | openai |
|---|---|---|---|
| Anthropic Messages | native (P4) | P5 | P5 |
| OpenAI Chat Completions | P5 | P5 (plugin relay logic) | P5 |
| Gemini generateContent | P5 | near-native (P4) | P5 |
| OpenAI Responses | P5 | P5 | native (P4.5) |

5a canonical model completed; FeatureSupport rows from E3 and the OpenAI findings; usage and finish maps; signatures
bound to their issuing provider. 5b decode/encode per dialect (stream and non-stream), each rule citing a spec. 5c
provider mappers (claude: canonical → Messages through the envelope and guards; antigravity: the existing `generate.ts`
/ `antigravity-chat.ts`; openai: canonical → Responses with the limits). 5d token counting only where a provider has an
endpoint, else 400 `unsupported_feature`. 5e e2e: 12 cells × {stream, non-stream} × {text, tool loop} plus errors (401,
400, 404, 429, 502, mid-stream error); the e2e deferral list ends empty; `verify` PASS. 5f docs, commit, push.

## 5. Phases P6–P10
- **P6** live validation of all 12 cells: pass/fail, time to first token, inter-chunk timing →
  `docs/reference/<ts>-live-results.md`.
- **P7** documentation sweep: README how-tos (Anthropic, OpenAI Chat + Responses, Google SDKs, Claude Code via
  `ANTHROPIC_BASE_URL`, OpenAI-compatible tools), diagram (components, flows, renewal under locks, matrix), AGENTS.md,
  plan statuses.
- **P8** plugin migration (`opencode-claude-auth`, then `opencode-antigravity-auth`), each to its own full gate and a
  commit; installation into OpenCode is the user's step. Out of scope: cheaper-inference-auth and opencode's own OpenAI
  sign-in.
- **P9** stabilise: full `verify`, live re-run, session record, Hindsight, project memory.
- **P10** nothing left: Responses moved into P4.5/P5; API-key providers stay excluded (2026-10-06).

## 6. Rollback
Every phase ends with its own commit on top of pushed history (`git revert` works). Router credentials stay in
`~/.local/share/inference-router/`. Nothing outside the repo, the data directory and `/tmp/opencode` is modified before P8.

## 7. Stops (the only points where execution waits for the user)
- Browser sign-ins: OpenAI (P4.5 step 2), re-logins needed after E4.
- O3 (repo visibility) before the first OpenAI sign-in.
- A quota limit hit during a live run.
- Live evidence that contradicts a rule here: an amendment is written and the user is asked; nothing is guessed.

## 7a. Amendment 2026-10-12: Phase P4.6 (API-key gateways)

The user asked to add Cheaper Inference, the OpenCode API (Zen and Go) and OpenRouter while the OpenAI sign-in is
pending. Planned in [P4.6](2026-10-12-15-35-p46-gateway-providers-plan.md) (decisions N1–N9); it runs before P5, and
the P4.5 live part follows when the user signs in to OpenAI. §3–§4 above stay as written; P5's matrix grows to the
seven providers (main plan "Changes v4 → v4.1").

## 7b. Amendment 2026-10-19: P8 cancelled (user decision, option A)

P8 (§5) is cancelled; §5 and decision O12 stay as written above. Reasons: the two plugins would depend on this
repository's packages, which are published nowhere, so they would stop being self-contained; the proxy has moved away
from them (it does not translate between formats, and its Claude thinking rule F9 differs on purpose); and the proxy
already lives beside them without conflict (its own credentials in `~/.local/share/accounts-proxy/`). From now on
this project never modifies the plugin repositories (`opencode-claude-auth`, `opencode-antigravity-auth`,
`opencode-cheaper-inference-auth`) or the plugin files installed in OpenCode (AGENTS.md §4 "Plugins"). Next: P9.

## 8. Execution record
- 2026-10-11 22:11 plan written and approved.
- 2026-10-11 23:06 **Phase H done** (H-a…H-h). `OAuthSessionBase` (`packages/core/src/ports/outbound/session.ts`) is the
  base of both sessions; account files are written only through `CredentialStorePort.update` (locked
  read-change-write); token calls are bounded by 30 s (< 60 s lock staleness, asserted by a test); Claude renews and
  resends once on an upstream 401; a transient renewal failure keeps a still-valid token and waits 30 s
  (`RENEWAL_RETRY_AFTER_MS`, added when the e2e lock test showed every request otherwise re-calls a failing
  endpoint); no HTTP answer is 502 `upstream_unreachable`; a rejected refresh marks the account `needsLogin`
  (`account list` shows it, a new login clears it). E4 ran ([E4](../reference/2026-10-11-23-06-e4-refresh-rotation.md)):
  Claude rotates and rejects the previous refresh token (`invalid_grant`), reuse does not revoke the new one; Google
  keeps the same refresh token; no re-login needed. `bun run verify`: GATE PASS (524 unit+component, 182 e2e, 100%
  everywhere).

- 2026-10-13 02:52 P4.5 live part and P6 (live validation) brought forward for the native cells: all seven providers
  validated live ([plan](2026-10-13-01-42-live-validation-plan.md),
  [findings](../reference/2026-10-13-02-52-live-validation-findings.md)); the live-only e2e deferrals are cleared. P6
  is still due for the translated cells after P5.

- 2026-10-18 P6 done for every native cell ([P6 plan](2026-10-17-22-59-p6-live-results-plan.md); P5 cancelled, so
  there are no translated cells): final run 72/72 pass, every cell streams incrementally, timing per cell in the
  [final results](../reference/2026-10-18-20-07-p6-live-results.md); the one proxy defect found (Claude
  count_tokens, deviation F10) fixed in 79a4a36.
- 2026-10-18 P7 done ([P7 plan](2026-10-18-22-09-p7-documentation-sweep-plan.md)): README "Use it from" table, client
  setup §3 (SDKs configured from the environment, run by the e2e tier), diagram pages request flow, renewal under
  locks and matrix, checked against the code in `verify`; the docs lint checks link fragments. Next: P8 (plugin
  migration).
- 2026-10-19 rule Z26 ([probe](../reference/2026-10-19-17-18-z26-opencode-free-tier-probe.md)): OpenCode's free `*-free` models answered 403 `FreeTierError` through the
  proxy while opencode itself got answers. OpenCode serves them only to a request with its own User-Agent
  (`opencode/<version>`) and its own prompts; the proxy replaced the client's User-Agent with `accounts-proxy/0.1.0`.
  The `opencode` and `opencode-go` cells now forward the client's User-Agent (the proxy's own when it sends none).
  Live: real opencode v2.0.32 through a test daemon answered OK on `ap-opencode/minimax-m3.1-flash-free`,
  `ap-opencode/glm-5.3-flash-free` and `ap-opencode-go/minimax-m3.1-flash-free`.
- 2026-10-19 P8 cancelled (§7b). Next: P9.
