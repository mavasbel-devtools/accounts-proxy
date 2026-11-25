# Session ses_ef10d7fa0ffe2baUvsApfbHHPZ — inference-router

Canonical session record. An earlier copy lived at `AIML/tools/docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`
(entries up to 2026-10-06 00:23) on the Windows machine; it is not present on the Linux machine (2026-10-10).

## Timeline
- 2026-10-05 20:07 Research: [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](../research/2026-10-05-20-07-llm-router-from-auth-plugins.md)
- 2026-10-06 00:14 Plan v1 drafted (llm-router), now superseded.
- 2026-10-06 00:23 Plan v2 (inference-router at AIML/inference-router; subscription providers only).
- 2026-10-06 ~00:25 **Plan v3 LOCKED.** C1 was confirmed (no API-key providers) and D10 added (browser login).
  [docs/plans/2026-10-06-00-23-inference-router-plan.md](../plans/2026-10-06-00-23-inference-router-plan.md)
- 2026-10-06 00:32 P0-E1 (specs), P0-E5 (port 4141) and P0-E6 (browser login; Claude loopback proven from the official
  2.1.280 binary) done. Amendment A1: E2/E3/E4 move to a P0-LIVE gate after the P3 logins exist.
- 2026-10-06 P1 scaffold: workspace, 7 workspaces with tests/{unit,component,live,e2e}, arch test, removeTemporary,
  istanbul gate scripts, verify, docs lint, AGENTS/README/drawio.

- 2026-10-06 P2 core (commit 56a4a7f): canonical domain, RouterError tree, negotiate/drop, SseCodec, base64url, ports.
- 2026-10-07 P3a provider-claude (commit fee4757): byte-parity gate vs opencode-claude-auth@6292741 (44 cases),
  fixes F1 streaming, F2 locked single-flight refresh, F3 no budget clamp, F4 loopback login (+user:plugins),
  F7 64-hex device id (official iD()), F8 own-property model lookup; D-4 (client anthropic-beta merge) deferred to
  P0-LIVE. Unit gate 100% (577/577 st, 454/454 br, 120/120 fn, 472/472 ln). Spec/fixture bytes verified after commit.

- 2026-10-07 P3b provider-antigravity (commit 7ea0f35): parity vs opencode-antigravity-auth@5c6f7c2 (catalog,
  project, quota, trajectory, generate, captured stream); fixes G2 locked single-flight refresh, G5 proactive refresh
  on chat, G6 429→quota_exhausted (no rotation); A1–A5 documented in PROVENANCE.md. Native Gemini cell mapping,
  body-embedded quota and RetryInfo wait on P0-LIVE. Unit gate 100% (1125 st, 941 br, 244 fn, 921 ln; 260 tests).
- Note: opencode-antigravity-auth AGENTS.md wire law 13 still describes "gemini → -1"; its code (and memory #932)
  is catalog-exact. Doc drift in that repo, not touched (out of scope until P8).

- 2026-10-07 P3c router app: config (strict router.yaml, D4 opt-in), LoginService (loopback browser login, PKCE
  only where the provider uses it, --manual paste-code for Claude), account/usage/models services, file stores
  (atomic, 0600, corrupt = error), FileLock (O_EXCL, stale break, timeout), FetchTransport, loopback listener (holds
  the browser request until the outcome), CLI driver + composition + bin. Unit gate 100% (1545 st, 1162 br, 347 fn,
  1276 ln; 340 tests). Then alias-imports plan docs/plans/2026-10-07-00-31-alias-imports-plan.md (approved: A /
  scripts yes / byte-identical references); step-0 probes all passed (see plan §2).

- 2026-10-07 alias imports executed (plan 2026-10-07-00-31, evidence docs/reference/2026-10-07-00-47-alias-imports-
  evidence.md): every own import is `@inference-router/<ws>/<subpath>.ts`; new workspaces test-support and scripts;
  vendored references byte-identical with nested tsconfig; arch gate enforces alias law + declared workspace deps.
  Bun 1.4.2 isolated linker: a workspace resolves another only if declared (`workspace:*`).

- 2026-10-07 01:23 next = P0-LIVE (amendment A1, before P4). router.yaml installed in ~/.local/share/inference-router
  (both providers on). Plan docs/plans/2026-10-07-01-23-p0-live-gate-plan.md awaiting approval; blocked on the user's
  two browser logins.

- 2026-10-10 18:45 Moved to Linux: repo `/home/mavasbel/Dev/repos/inference-router`, plugins
  `/home/mavasbel/Dev/repos/devtools/opencode-{claude,antigravity}-auth`. Validated (docs/reference/2026-10-10-18-45-
  linux-migration-validation.md): clean `bun install`, gate identical to Windows. Provider id `claude-subscription` →
  `claude` (plan v3.1); created dirs 0700, lock/log files 0600. router.yaml recreated on Linux. Next: decisions in
  docs/plans/2026-10-10-18-45-continuation-plan.md (P0-LIVE approval + logins; amendment A2 = P4 first; P4 start).

- 2026-10-10 19:00 User approved the continuation decisions (P0-LIVE, A2, start P4). Detailed P4 plan written:
  docs/plans/2026-10-10-19-00-p4-daemon-native-cells-plan.md, awaiting approval of Q1–Q5. Findings: Claude F4
  (client anthropic-beta) not implemented; Antigravity has no countTokens endpoint; e2e-alone 100% law is risk R1.

- 2026-10-11 User signed in both providers and approved: live tests before P4, P4 Q1–Q5 as recommended. Ran
  `models`/`quota` checks, E2 (11 exchanges) and E3 (56 cells, 4 runs). Findings L1–L15; P4 plan amendment B adds
  Q6 (Claude thinking cannot be disabled through the envelope) and Q7 (Windows fingerprints), awaiting decision.
  `.cortexkit/` (Magic Context local state) added to .gitignore.

- 2026-10-11 User approved Q6/Q7. P4 built (core, Claude F4/F9, Antigravity runner + native cell, dialect codecs,
  route table, node:http server, CLI serve/token/status, seams); unit+component 100% (486 tests), merged 100%;
  e2e 21 tests pass but e2e-alone coverage 73%/55% → risk R1 report docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md,
  awaiting the user's decision.
- 2026-10-11 User chose R1 option B. Done: P5-only code deferred by name (scripts/gate/e2e-deferred.ts, 11 entries,
  must be empty after P5); unreachable branches removed; five hermetic hooks (only with all four seams); e2e grown to
  177 tests. e2e alone 100%, unit+component 100% (497), merged 100%; `bun run verify` GATE: PASS. Fixed: Antigravity
  signature-store write race (found by the 2001-signature e2e test). Next: P0-E4 (refresh-token test, may cost one
  re-login), then P5.
- 2026-10-11 User asked to add OpenAI (opencode's built-in ChatGPT sign-in) and to finish everything; plans are only
  ever extended. Plan v4 written: docs/plans/2026-10-11-22-11-completion-plan.md (Phase H → P4.5 → P5 → P9), main
  plan extended (Changes v3.1 → v4). Decisions H-Q1..6, O1..O12 approved (O9 changed by the user: send opencode's
  session headers); O3 (repo visibility) open.
- 2026-10-11 Phase H done (6eda43e): OAuthSessionBase, locked account writes, 30 s token deadline, Claude 401
  retry, H4 fallback + 30 s cooldown, 502 upstream_unreachable, needsLogin. E4 live: Claude rotates refresh tokens
  and rejects the old one; Google does not. verify GATE PASS.
- 2026-10-12 P4.5 part 1 (acce877): packages/provider-openai (SIWC dynamic registration, JWKS ID-token check, session,
  model list, native Responses route with limits/aggregation/opencode headers); unit+component 100%. Live probe script
  ready (scripts/evidence/live/p45-openai-probe.ts). Waiting: user sign-in `bun run router login openai` (+ O3).
- 2026-10-12 User: repo stays private (O3); add Cheaper Inference, OpenCode Zen/Go, OpenRouter while OpenAI waits.
  Plan P4.6 (docs/plans/2026-10-12-15-35-p46-gateway-providers-plan.md, N1–N9 approved). 2026-10-12 17:08: built and tested
  (provider-gateway + three vendor packages, routing by wire format, Chat route, PKCE/key logins, quota). Live: Zen
  keyless → 403 FreeTierError (Z8). verify GATE PASS (646 unit+component, 193 e2e, 100%). Waiting: the user's gateway
  keys (live probes) and OpenAI sign-in.
- 2026-10-12/13 User: OpenCode's Console replaced its key pages; use the same login as `opencode auth login`. Amendment A
  of plan P4.6 (K1–K6 approved): device login under client id `inference-router`, one Console account for opencode and
  opencode-go, `--key` (service-account key), `--from-opencode` (API keys only), config from /console/api/v2/config, new
  /inference addresses with bearer keys. Built and tested; waiting: the user's `login opencode` (A5 live probe).
- 2026-10-19/21 Recon MITM captures of reference clients (opencode, Claude Code 2.1.304, Antigravity 1.107.0).
  Hermetic profile sandbox under bubblewrap, dedicated MITM CA, DOM-driven automation, identity redaction.
  Wire law 7 confirmed: Antigravity tool results return as model-role content.
- 2026-10-21/22 Recon parity tool and gap report (docs/reference/2026-10-21-20-44-recon-gap-report.md).
  Remediated gaps C1–C10 for Claude Code 2.1.304: 17 beta headers, startup reads, model selector endpoint,
  canonical header order/casing, billing blocks, exact client profile.
  Recon parity tool reports 0 differences against captured Claude Code 2.1.304 traffic.
  Remediated gaps A1–A4 for Antigravity 1.107.0: Linux user-agent alignment via ANTIGRAVITY_PROFILE,
  one functionDeclarations per tools entry (eliminating 28 body differences), transport residuals classified.
  Recon parity tool reports 0 differences against captured Antigravity 1.107.0 traffic.
  bun run verify: GATE PASS (800 unit+component, 230 e2e, 100% on statements, branches, functions, lines across all tiers, both parity gates pass).

## Progress map
| Phase | State |
|---|---|
| P0-E1/E5/E6 | done |
| P0-E2/E3 | done 2026-10-11 (docs/reference/2026-10-10-23-17-p0-live-findings.md) |
| P0-E4 | done 2026-10-11 (docs/reference/2026-10-11-23-06-e4-refresh-rotation.md) |
| P1 | done |
| P2 | done |
| P3 | done (providers, router CLI, alias imports) |
| Linux migration + rename to `claude` | done 2026-10-10 |
| P4 | done 2026-10-11; R1 resolved (option B), `bun run verify` GATE: PASS |
| Phase H (plan v4) | done 2026-10-11 |
| P4.5 openai | done; live-validated and e2e-covered 2026-10-13 |
| P4.6 API-key gateways | done; live-validated 2026-10-13 |
| P4.6 amendment A (OpenCode Console) | done; live-validated 2026-10-13 |
| Live validation L0–L4 (all seven providers) | done 2026-10-13 |
| P5 (translation) | cancelled 2026-10-14 (D1-A); translation-only code removed 2026-10-16 (C1) |
| Model catalog + opencode config + documentation ([plan](../plans/2026-10-16-00-08-model-catalog-docs-plan.md)) | C0–C6 done 2026-10-16 (C2–C5 commit 98f610f; C6 live with opencode v2.0.26, rule O6); C7 done 2026-10-17: six reference documents (API, OpenAPI 3.1, providers, format fields, generated models, client setup) with docs-in-step unit and e2e checks in `verify` (GATE PASS) |
| Project rename to `accounts-proxy` ([record](../reference/2026-10-16-14-40-project-rename.md), plan amendment R) | done 2026-10-17: R0–R7 (commit 427c395; repository and directory renamed; live check on the user's daemon: 7 providers, opencode `ap-<provider>`) |
| P6 live results ([plan](../plans/2026-10-17-22-59-p6-live-results-plan.md)) | 2026-10-18: run 1 ([results](../reference/2026-10-18-18-37-p6-live-results.md)) 71/72 pass, every cell streams incrementally except one upstream burst on `cheaper-inference` Responses; the `claude` count_tokens 400 fixed as deviation F10 (probes 18-39, 18-47, 18-49). Final run 2026-10-18 20:07 ([results](../reference/2026-10-18-20-07-p6-live-results.md)): 72/72 pass; the remaining unusual readings probed to the upstream (probes 20-09, 20-11). **P6 done** |
| P7 documentation sweep ([plan](../plans/2026-10-18-22-09-p7-documentation-sweep-plan.md)) | 2026-10-18: README "Use it from", client setup §3 (environment-configured SDKs, e2e), diagram pages request flow / renewal under locks / matrix checked in docs-in-step, docs lint checks link fragments, AGENTS.md §1/§4/§7, plan statuses. **P7 done** |
| P8 plugin migration | cancelled 2026-10-19 by the user (plan v4 §7b; AGENTS.md §4 "Plugins": the plugin repositories and installed plugins are never modified) |
| Rule Z26 OpenCode free models ([probe](../reference/2026-10-19-17-18-z26-opencode-free-tier-probe.md)) | 2026-10-19: the `opencode`/`opencode-go` cells forward the client's User-Agent (the proxy's own when none); live: opencode v2.0.32 through a test daemon answered OK on three free models |
| Recon MITM capture & parity ([plan](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md)) | R1–R6 done 2026-10-22: Claude Code 2.1.304 parity 0 diffs, Antigravity 1.107.0 parity 0 diffs, verify GATE PASS (800 unit, 230 e2e, 100% on all metrics) |
| P9 | not started |

## 2026-10-22 22:40 — OpenCode v2.1.1 parity closed; OpenAI next

- Committed `fa0967d` (Antigravity R6) and `e55572f` (OpenCode R6: O1–O5, 13 requests 0 differences, verify GATE PASS:
  803 unit+component+arch, 230 e2e, merged 100% 3527/3527 statements, 2592/2592 branches).
- Plan §23, gap report §7. New manifest pattern `workspace` (`wrk_` + 26).
- Open: OpenAI cell against opencode's "Sign in with ChatGPT" (option A). A sign-in inside the opencode recon profile
  (`run opencode --login -- … auth login --standalone openai --method chatgpt-token-sharing`) waits for the
  operator's browser approval; then record turns with `--model=openai/<model>`, add the `openai` parity cell, fix gaps.

## 2026-10-24 13:27 — Antigravity sign-in persists across runs

- Root cause of "one consent per Antigravity recording": the runner SIGTERMed the outer `bwrap`, so the client was
  SIGKILLed with its namespace and never ran its shutdown hook, the only place it writes `antigravityUnifiedStateSync.*`
  (the sign-in). Fix: `scripts/recon/sandbox/stop.ts` stops the command inside the sandbox first (30 s grace).
- Proof: consent 13:08 (run `2026-10-24-19-02-19-login`); launches at 13:19 and 13:22 and the `turn` workflow at 13:25
  came up `signedIn` with no login; the turn recorded `streamGenerateContent` 200 (seq 265, 277).
- Records: [login profiles §10](../reference/2026-10-20-12-13-recon-login-profiles.md#10-antigravity-keeps-its-sign-in-across-runs-2026-10-24),
  [plan §26](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md#26-amendment--antigravity-sign-in-persists-the-client-is-stopped-inside-the-sandbox-2026-10-24-1327).
- Open: Codex (deferred); 13 `home.*.bak` Antigravity profiles await the operator's decision.

## 2026-10-25 15:40 — M1 Media Probe & OpenRouter Validation Complete

- M1 Media Probe ([plan](../plans/2026-10-24-21-08-media-support-plan.md), [record](../reference/2026-10-24-21-05-m1-media-probe.md)):
  All providers tested across supported media modalities (PNG, PDF, WAV, VP9 WebM).
  Antigravity native Gemini cell now supports `inlineData`, `fileData` with `fileUri` (+ `mimeType`),
  `generationConfig.responseModalities` `TEXT`/`IMAGE`, and `mediaResolution` `LOW`/`MEDIUM`/`HIGH`.
- OpenRouter media validation: imported active key from OpenCode (`bun run proxy login openrouter --from-opencode`).
  All four media modalities (`openrouter-image`, `openrouter-pdf`, `openrouter-audio`, `openrouter-video`) re-probed
  live through the daemon and verified 200 ACCEPTED (PELICAN recognized).
- Backup profile cleanup: old `home.*.bak` directories purged (~1.1 GB freed).
- Verification gate: `bun run verify` GATE: PASS (895 unit+component+arch, 257 e2e, 100% coverage on statements,
  branches, functions, lines across every tier, 11 recon parity checks pass with 0 differences, docs lint PASS).

## 2026-10-29 — Cached model lists (plan 2026-10-28-13-40) pushed

- Committed and pushed `9513f7f`: every model list (Antigravity included) kept in memory and stored
  (`ModelListCacheBase`), fetched once at `serve` start (`WarmModelsService`), refreshed in the background past
  `modelListMaxAgeMinutes` or `MODEL_LIST_RETRY_MS` (60 s) after a failure, every fetch logged
  ([plan](../plans/2026-10-28-13-40-cached-model-lists-plan.md)). `bun run verify` GATE: PASS.
- Live (daemon pid 979093, 16:38:09Z): one start-up fetch per provider, all `live`; 11 opencode config requests
  added no upstream model-list call.
- Secret audit of the pushed diff: 0 real values, 0 pattern matches.
- Open: M8 (c), the offline-start check; data layout: only accounts, locks and logs are in `.cache/`, the rest
  (`proxy.yaml`, `token.json`, `state/`, `backups/`, `recon/`) stays in `~/.local/share/accounts-proxy/`.

## 2026-10-29 17:50 MDT — self-contained-cache S8 applied

- The daemon was confirmed stopped before the move. `proxy.yaml`, the established token, full `state/`, `recon/` and
  `backups/` were moved from `~/.local/share/accounts-proxy/` to the repository `.cache/` by same-filesystem rename.
  The move tool checked path, size, mode and SHA-256 before and after every active item.
- A different token and partial `state/model-reference.json` had already appeared under `.cache/` after a direct CLI
  invocation with no cache config. They are preserved under `.cache/backups/`; the established October 11 token and the
  complete live state are active. The configured seven providers are all enabled; subscription providers acknowledge
  their terms risk.
- Backup account data stays preserved: two backup ids are not in `accounts.json`. The former home was otherwise empty,
  so its empty `locks/` and `logs/` and the parent were removed. S9 is now in progress: refresh, isolation, daemon,
  gate, secret audit, commit and push.

## 2026-10-29 19:12 CST — self-contained-cache S9 verified

- Every enabled provider refreshed live: Claude 12 models, Antigravity 21, OpenAI 8, OpenRouter 456, OpenCode 130,
  OpenCode Go 37 and Cheaper Inference 340. The daemon is listening on `127.0.0.1:4141` from the default repository
  cache home.
- The recon isolation acceptance probe reported `clean` and `unchanged` for OpenCode, Antigravity, Claude and Codex.
  The complete `bun run verify` gate passed: typecheck, 100% unit/component/architecture coverage, build, 100% e2e and
  merged coverage, every recon parity check and docs lint.
- During verification, the docs linter was corrected to ignore the mutable `.cache/` tree and its new regression test
  passed. The e2e modules now use the single 120-second gate timeout and run with two workers, after the prior 60-second
  module-local overrides killed child processes under host load.

## 2026-10-30 08:40 CST — self-contained-cache S9 committed and pushed

- Complete secret and identity audit ran against all staged changes with zero personal identifiers and zero credentials found.
- Committed as `2a49cec` (`proxy: all data lives in <repo>/.cache, drop K5 --from-opencode, provider prefix AP (plan 2026-10-29-14-38 S1–S9)`) and pushed to `origin/main`.
- Working tree clean on `main`; verified no worktree remains to merge or delete. Daemon confirmed active on `127.0.0.1:4141`.
- 2026-11-01 / 2026-11-02: Executed Antigravity tool calling capabilities and model resolution fix (plan [docs/plans/2026-11-02-01-37-antigravity-tool-capabilities-plan.md](../plans/2026-11-02-01-37-antigravity-tool-capabilities-plan.md)).
  - Declared `toolCall: true` for generative Gemini descriptors in `packages/provider-antigravity/src/domain/catalog.ts`.
  - Normalized model tier suffixes (`-extra-low`, `-low`, `-medium`, `-high`, `-tiered`) in `packages/core/src/domain/model-details.ts` so `gemini-3.8-flash-medium` inherits `toolCall: true` from reference `google/gemini-3.8-flash`.
  - Configured configurable log total size cap (`maxTotalMegabytes: 500`) across `packages/core/src/domain/config.ts` and `apps/proxy/src/adapters/outbound/log-files.ts`.
  - Audited all 21 Antigravity models: 18 generative models have `capabilities.tools: true`; only the 3 non-generative / specialized models (`gemini-3.1-flash-image`, `tab_flash_lite_preview`, `tab_jump_flash_lite_preview`) are false.
  - Executed Clean Console enforcement (plan [docs/plans/2026-11-02-05-30-console-logging-and-openai-plan.md](../plans/2026-11-02-05-30-console-logging-and-openai-plan.md)): removed `mirror` from `StreamExchangeSink` in `apps/proxy/src/composition/container.ts` so full HTTP request and response JSON records are logged exclusively to `.cache/logs/*-usage.*.jsonl` rather than dumping to stdout in the terminal.
  - Conducted forensic root-cause analysis on OpenAI stopping vs Gemini (research [docs/research/2026-11-02-05-05-openai-router-investigation.md](../research/2026-11-02-05-05-openai-router-investigation.md)): verified OpenAI does not have the catalog tools defect (tools: true), identified high reasoning latency (up to 30.4s TTFT) and client aborts as causes of stops.
  - Verified 100% unit+component+arch coverage (995/995 pass, 49,984 expectations, 100% stmts/branch/funcs/lines), clean TypeScript typecheck, bundle build, and docs lint.


## 2026-11-02 22:10 CST — Antigravity real context window (plan 2026-11-02-21-29)

Plan: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/plans/2026-11-02-21-29-antigravity-real-context-window-plan.md`.
Issue: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/issues/2026-11-02-21-29-antigravity-80k-window-refusals.md`.
This corrects the earlier `toolCall` attribution: the ~60 s stops were Magic Context refusing the turn, because of the
80k window the proxy advertised.

- [x] S1 `IDE_WORKING_SET_CONTEXT_CAP` and `advertisedContextWindow` removed; `advertisedLimits` returns the catalog's
  `maxTokens` / `maxOutputTokens`. `git grep` finds no clamp in `packages/*/src` or `apps/*/src`.
- [x] S2 parity reference re-vendored at `ba0ae60db52b5318e52f04a662a2cccaf65bd114` into
  `packages/provider-antigravity/tests/reference/plugin-ba0ae60/` (10 files, 0 blob mismatches); `plugin-5c6f7c2/`
  removed; `parity.test.ts` compares the plugin's `supportedMimeTypes` with the proxy's `mimeTypes` on both catalogs.
- [x] S3 unit, component and e2e expectations moved from 80000 to the catalog values; a new e2e assertion on
  `opencode-config` checks `gemini-3.8-flash-medium` 1048576/65536, `claude-opus-5-5-high` 1000000/128000 and
  `gpt-oss-120b-medium` 131072/32768.
- [x] S4 model reference regenerated (29 Antigravity rows); AGENTS.md, rules M-table and PROVENANCE.md updated.
- [x] S5 `bun run verify` GATE: PASS: 995 unit+component and 269 e2e tests pass, 100% on all tiers, docs lint clean.
  The first run had one component timeout (`container.test.ts` daemon wiring, 5000 ms) while `llama-server` used
  343% CPU (load average 12.9); in isolation it passed 3/3 in 2.4–3.0 s, and the second full run passed with no change.

## 2026-11-11 03:17 — Plan: cheapest similar-performance model routing (drafted, awaiting approval)

- Surveyed the request path (`apps/proxy/src/application/passthrough-service.ts:20-29`), the model record
  (`packages/core/src/domain/model-details.ts:16-23,49`) and the cost plumbing: the proxy holds a price per model for the
  four gateway providers and no price for the three subscription cells (rule M5, `model-details.ts:169`), and holds **no**
  quality notion at all (grep for `score|rank|quality|benchmark` over `packages/*/src` and `apps/proxy/src` returns only
  prose inside model descriptions).
- Measured the gap on the daemon's live catalog of 2026-11-10 joined to the BenchLM BenchAlign composite: two models 0.09
  points apart (`muse-spark-1.2` 65.35, `ling-3.1-flash` 65.26) differ 27.8× in input price.
- Wrote [docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md](../plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md)
  (`sha256 a34596a0748fb2233e73996d58b390a002bedefbf982379533f6dd41a07e8f2d`): 8 stages, 40 steps, decisions D1–D11,
  use cases uc-1…uc-7 each with its negative scenario, a closed inventory of 20 created and 14 edited files.
- No code, no document outside `docs/` and no command outside read-only evidence gathering was run. Nothing is executed
  before the plan is approved.
