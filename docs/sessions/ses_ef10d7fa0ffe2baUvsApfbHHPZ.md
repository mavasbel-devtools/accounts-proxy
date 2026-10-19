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
  `/home/mavasbel/Dev/repos/opencode/opencode-{claude,antigravity}-auth`. Validated (docs/reference/2026-10-10-18-45-
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
- 2026-10-13 User signed in to every provider; asked to test everything (tokens, errors, renewal, turns, MCP).
  Live validation L0–L4 (docs/plans/2026-10-13-01-42-live-validation-plan.md, findings
  docs/reference/2026-10-13-02-52-live-validation-findings.md): every native cell of the seven providers works through
  the daemon with the official SDKs, Claude Code and opencode (MCP tools, multi-turn); OpenAI and Console refresh tokens
  rotate (L2). Fixes I6, F2 (parametersJsonSchema), Z24, F6–F9; live-only e2e deferrals cleared.

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
| P7–P9 | not started |
