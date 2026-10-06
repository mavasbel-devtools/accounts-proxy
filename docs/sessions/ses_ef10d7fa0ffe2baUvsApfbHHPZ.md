# Session ses_ef10d7fa0ffe2baUvsApfbHHPZ — inference-router

Canonical session record. An earlier copy lives at `AIML/tools/docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`
(entries up to 2026-10-06 00:23).

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

## Progress map
| Phase | State |
|---|---|
| P0-E1/E5/E6 | done |
| P0-E2/E3/E4 | waiting on the P0-LIVE gate (needs the user's browser logins after P3) |
| P1 | in progress |
| P2–P10 | not started |
