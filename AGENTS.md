# AGENTS.md — inference-router laws (non-negotiable)

Plan: [docs/plans/2026-10-06-00-23-inference-router-plan.md](docs/plans/2026-10-06-00-23-inference-router-plan.md) ·
Research: [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md)

## 1. What this is
A local daemon on `127.0.0.1` that exposes the Anthropic Messages, OpenAI Chat Completions and Gemini `generateContent`
dialects. It routes each request to one of two subscription providers: `claude-subscription` (Anthropic Messages upstream)
and `antigravity` (Google Cloud Code Assist envelope upstream). It has no API-key providers (user decision 2026-10-06).

## 2. Architecture law (enforced by `tests/arch/architecture.test.ts`; part of `verify`)
- **Workspaces.**
  - `packages/core`: domain and ports only.
  - `packages/provider-*`: domain (pure provider rules) and `adapters/outbound`.
  - `packages/dialect-*`: `adapters/inbound` codecs.
  - `apps/router`: application, `adapters/{inbound,outbound}`, `composition`, `main`.
- **Layers** are recognised by path: `src/domain`, `src/ports/{inbound,outbound}`, `src/application`,
  `src/adapters/{inbound,outbound}`, `src/composition`, `src/main`. A file anywhere else under `src/` fails the gate.
- **Allowed internal imports:**
  - domain → domain
  - ports/inbound → domain, ports/inbound
  - ports/outbound → domain, ports/outbound
  - application → domain, ports
  - adapters/inbound → domain, ports/inbound, adapters/inbound
  - adapters/outbound → domain, ports/outbound, adapters/outbound
  - composition → all
  - main → composition
- **External imports** (`node:*`, third-party) are allowed only in adapters, composition and main. Domain, ports and
  application are pure TypeScript.
- **Workspace imports** always use an explicit subpath (`@inference-router/core/domain/...`). Barrel imports are forbidden.
- **Abstractions.** Every port is an abstract class or interface. Every implementation extends or implements one.
  Constructor parameters and return types are abstractions (IoC). Concrete wiring happens only in `apps/router/src/composition`.

## 3. Wire laws carried from the source plugins (must never regress)

| Law | Origin |
|---|---|
| Antigravity `thinkingConfig.thinkingBudget` = the catalog's `thinkingBudget`, verbatim (catalog-exact) | opencode-antigravity-auth `ModelCatalogService.ts:84-99` |
| Antigravity int64 `sessionId` stays a decimal string end to end (never `Number()`) | `TrajectoryStateService.ts:64-73` |
| Claude `thinking` is rebuilt from scratch, which strips `thinking.adaptive.block_binding` and every extra key | opencode-claude-auth `RequestTransformService.ts:256-281` |
| Claude prefill guard L1/L2/L3 (no trailing assistant/tool; orphan tool results rebuilt or dropped) | `RequestTransformService.ts:86-166` |
| Antigravity trajectory labels, requestId format, step counter | `TrajectoryStateService.ts:76-204` |
| Antigravity `thoughtSignature` capture/replay; unsigned Gemini calls dropped with their results | `RequestTransformService.ts:186-277` |
| Claude identity envelope (billing block, identity block, `metadata.user_id`, `context_management`, betas) | `RequestTransformService.ts:187-298`, `ModelEnvelope.ts:49-190` |

## 4. Behaviour laws
- **Evidence only.** Every translation rule cites a spec in `docs/reference/specs/` or a capture in
  `tests/fixtures/captures/`. Nothing is guessed.
- **Strict translation.** A feature the target cannot carry returns 400 `unsupported_feature`. Dropping happens only
  with `x-router-lossy: 1`, and the response then reports `x-router-dropped`.
- **Quota.** 429 / quota errors are surfaced with `retry-after`. There is **no** automatic account rotation.
- **Browser login.** `inference-router login <provider>` opens the browser and captures the loopback redirect.
  Paste-code exists only as the headless fallback (`--manual`). Evidence:
  [P0-E6](docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md).
- **Own credentials.** The router's credentials live only in `~/.local/share/inference-router/`. The router never
  writes Claude Code's or the plugins' credential files.
- **Local access.** The daemon binds `127.0.0.1` on the configured port only (default 4141; `EADDRINUSE` is fatal).
  Every route except `/health` requires the router token, compared in constant time.
- **Opt-in providers.** A subscription provider starts only with `acknowledgeTermsRisk: true` in config.

## 5. Tests and gate
- Every workspace has `tests/{unit,component,live,e2e}`.
- **Coverage** is measured with Babel + istanbul (`scripts/gate/`). It must be exactly 100% lines, statements, functions
  and branches for unit+component, for e2e, and merged. It must also be **complete**: every source file with runtime
  code must be loaded by some test.
- **E2E coverage** comes from daemon processes started with `--preload scripts/gate/e2e-coverage-preload.ts`. A daemon
  must exit through a normal exit path, never a hard kill, or its coverage is lost.
- **Recursive deletes** in tests go only through `tests/support/temporary.ts#removeTemporary`, which refuses anything
  outside `os.tmpdir()`.
- **`bun run verify`** runs typecheck → unit+component+arch coverage gate → build → e2e gate → merged gate → docs lint.
  It reports INCOMPLETE (exit 3) while a tier has nothing to run yet, and never reports that as a pass.
- **`bun run test:live`** runs the real accounts tier. It sets `INFERENCE_ROUTER_LIVE=1` itself and is never part of `verify`.

## 6. Pins (exact versions only; no ranges, no `latest`)
- Bun 1.4.2
- typescript 5.9.3, @types/bun 1.4.2
- @babel/core 8.0.1, @babel/plugin-transform-typescript 8.0.1, babel-plugin-istanbul 8.0.0
- istanbul-lib-coverage 3.2.2, istanbul-lib-report 3.0.1, istanbul-reports 3.2.0
- @types/istanbul-lib-coverage 2.0.6, @types/istanbul-lib-report 3.0.3, @types/istanbul-reports 3.0.4

## 7. Docs
- Files under `docs/{plans,research,issues,reference,temp}` are named `YYYY-MM-DD-HH-MM-<name>.md`, using the system clock.
- Session records are `docs/sessions/<session-id>.md`.
- README, this file, plans and diagrams are kept in exact sync with the code and the measured results after every change.
