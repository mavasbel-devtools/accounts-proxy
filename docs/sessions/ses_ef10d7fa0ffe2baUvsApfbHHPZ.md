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

## Progress map
| Phase | State |
|---|---|
| P0-E1/E5/E6 | done |
| P0-E2/E3 | done 2026-10-11 (docs/reference/2026-10-10-23-17-p0-live-findings.md) |
| P0-E4 | after P4 (can cost one re-login) |
| P1 | done |
| P2 | done |
| P3 | done (providers, router CLI, alias imports) |
| Linux migration + rename to `claude` | done 2026-10-10 |
| P4–P10 | not started (P4 proposed ahead of P0-LIVE: amendment A2) |
