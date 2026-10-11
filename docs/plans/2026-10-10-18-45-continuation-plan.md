# Plan: continuation after the Linux migration (2026-10-10)

Status: **steps 0–1 executed; steps 2–4 proposed, awaiting approval**. Parent plan: [2026-10-06-00-23-inference-router-plan.md](2026-10-06-00-23-inference-router-plan.md) (v3.1).

## 1. Where the project stands (measured 2026-10-10)

| Phase | State | Evidence |
|---|---|---|
| P0-E1, E5, E6 | done (E5 re-measured free on Linux) | `docs/reference/2026-10-06-00-32-*`, [linux validation](../reference/2026-10-10-18-45-linux-migration-validation.md) |
| P1 scaffold, P2 core | done | commits up to `ff984b1` |
| P3 providers + CLI | done | `fee4757`, `7ea0f35`, `89cb5f5`; alias imports `9c357f0` |
| P0-LIVE (E2, E3, E4) | not started: needs the user's two browser logins | [p0-live plan](2026-10-07-01-23-p0-live-gate-plan.md) |
| P4 daemon + 2 native cells | not started | — |
| P5–P9 | not started | — |
| Gate | typecheck, unit+component+arch at 100%, build PASS; e2e and merged INCOMPLETE (no e2e tier) | `bun run verify` on Linux |

## 2. Steps

### Step 0: migration validation (executed)
- Paths, plugin commits, toolchain, line endings, vendored-reference blobs, a clean Linux `bun install --frozen-lockfile` (lockfile byte-identical), the full gate, and Linux runtime probes. All recorded in the validation doc.
- Historical docs that name Windows paths got migration notes; they were not rewritten.
- `~/.local/share/inference-router/router.yaml` was created on Linux (directory 700, file 600).

### Step 1: provider rename and hardening (executed)
- Provider id `claude-subscription` → `claude`, with no alias (user, 2026-10-10). 89 replacements in code, tests, config, README, AGENTS.md and plans. Historical records (research, reference, session) keep the old id.
- Hardening from the validation finding: every directory the router creates is 0700, and lock and log files are 0600 (`PRIVATE_DIRECTORY_MODE`, `PRIVATE_FILE_MODE` in `file-stores.ts`), with a component test.

### Step 2: P0-LIVE (blocked on the user's logins)
Unchanged from the [p0-live plan](2026-10-07-01-23-p0-live-gate-plan.md), apart from the Linux preconditions in its §1. Approval of that plan plus the two logins unblock it:
```
cd /home/mavasbel/Dev/repos/inference-router
bun run router login claude
bun run router login antigravity
```

### Step 3: re-sequence P4 before P0-LIVE (amendment A2, proposed)
Amendment A1 put P0-LIVE before P4. Re-reading what each phase consumes:
- **P4 does not consume E2/E3/E4.** The two native cells pass the client's own dialect through the provider packages, and those are already parity-tested against the plugins' committed real captures.
- **P5 depends on E3:** the fidelity matrix is the only source for the FeatureSupport tables.
- **D5 depends on E4.**
- **P6 is live by definition.**

Proposal A2: build P4 now, run P0-LIVE whenever the logins are done, and keep P5 blocked until E3 exists. No live call happens before the logins either way.

### Step 4: P4 (proposed, detailed before execution)
Scope from the parent plan:
- HttpServerAdapter (`node:http`, `127.0.0.1:4141`, `EADDRINUSE` fatal);
- AuthGuard: router token file, constant-time compare; carriers are `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` and `?key=`;
- the D2 route table, D8 model addressing, `/health`, and graceful stop on SIGINT/SIGTERM;
- the two native cells (Anthropic → `claude`, truly streamed; Gemini → `antigravity`);
- models endpoints in all three dialects;
- CLI `serve`, `token`, `status`;
- the first **e2e tier**: the built daemon under the coverage preload against loopback replay upstreams, plus the official SDKs. This turns the e2e and merged gates from INCOMPLETE into measured results.

Included from the P0-LIVE plan §7: the models output names its source (live, cache or static), in the CLI and over HTTP.

Before writing code, I will check the official SDK versions and their base-URL and auth options against current documentation (Context7). The SDK pins go into AGENTS.md §6.

## 3. Decisions requested
1. Approve the P0-LIVE plan (step 2), and do the two logins when convenient.
2. Approve amendment A2 (P4 before P0-LIVE).
3. Approve starting P4 (step 4); a detailed P4 plan comes first.
