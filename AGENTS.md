# AGENTS.md — inference-router laws (non-negotiable)

Plan: [docs/plans/2026-10-06-00-23-inference-router-plan.md](docs/plans/2026-10-06-00-23-inference-router-plan.md) ·
Research: [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md)

## 1. What this is
A local daemon on `127.0.0.1` that exposes the Anthropic Messages, OpenAI Chat Completions and Gemini `generateContent`
dialects. It routes each request to one of two subscription providers: `claude` (Anthropic Messages upstream)
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
- **Imports are aliases, never relative.** Every import of the repository's own code is
  `@inference-router/<workspace>/<subpath-with-.ts>`, also inside the same workspace (package self-reference) and in
  tests and scripts. Each workspace's `exports["./*"]` maps the subpath: `packages/*` and `apps/*` → `src/`,
  `@inference-router/test-support` → `tests/support/`, `@inference-router/scripts` → `scripts/`. Barrel imports are
  forbidden. The only relative or foreign-alias imports are inside the vendored parity references
  (`packages/*/tests/reference/plugin-<sha>/`): they are byte-identical to the plugin sources, and their own
  `tsconfig.json` maps the plugin's alias (`@claude/`, `@antigravity/`).
- **Declared workspace dependencies.** Bun 1.4.2 links a workspace only into workspaces that declare it, so a
  workspace imports another one only if it lists it (`"workspace:*"`; test-only use goes in `devDependencies`).
- The architecture gate enforces both rules on every `.ts` under `packages/*/{src,tests}`, `apps/*/{src,tests}`,
  `tests/` and `scripts/`. Its self-test injects relative, unresolvable and undeclared imports.
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
| Claude thinking is the client's: absent stays absent, `disabled` stays disabled, and the clear-thinking `context_management` edit is sent only with thinking on (deviation F9, user decision Q6) | [P0-LIVE L1–L3](docs/reference/2026-10-10-23-17-p0-live-findings.md), [Q6 probe](docs/reference/2026-10-10-23-20-q6-thinking-probe.md) |
| Antigravity Gemini cell: `functionResponse` parts move to model-role contents (law 7); only `AUTO`/`VALIDATED` function-calling modes | plugin wire law 7; P0-LIVE L6 |

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
- **Sessions** (plan v4 Phase H). Every provider session extends `OAuthSessionBase`
  (`packages/core/src/ports/outbound/session.ts`). Account files are written only through
  `CredentialStorePort.update` (a locked read → change → write); there is no blind save. Lock order is always renewal
  lock → store lock. A token-endpoint call is bounded by `TOKEN_ENDPOINT_TIMEOUT_MS` (30 s), which must stay below the
  lock staleness (60 s). A rejected refresh marks the account `needsLogin` (fast 401 until a new login); a transient
  renewal failure keeps a still-valid token for `RENEWAL_RETRY_AFTER_MS`. Claude retries once after renewing on an
  upstream 401, only before anything reaches the client.
- **Local access.** The daemon binds `127.0.0.1` on the configured port only (default 4141; `EADDRINUSE` is fatal).
  Every route except `/health` requires the router token (`<data>/token.json`, 0600), compared in constant time.
- **Test seams.** `INFERENCE_ROUTER_TEST_UPSTREAM_{CLAUDE_API,CLAUDE_OAUTH,ANTIGRAVITY_API,GOOGLE_OAUTH}` repoint a
  provider's hosts for hermetic e2e only, and only to an `http://127.0.0.1:<port>` origin; any other value is fatal.
- **Opt-in providers.** A subscription provider starts only with `acknowledgeTermsRisk: true` in config.

## 5. Tests and gate
- Every workspace has `tests/{unit,component,live,e2e}`.
- **Coverage** is measured with Babel + istanbul (`scripts/gate/`). It must be exactly 100% lines, statements, functions
  and branches for unit+component, for e2e, and merged. It must also be **complete**: every source file with runtime
  code must be loaded by some test.
- **E2E coverage** comes from router processes (the source entry `apps/router/src/main/cli.ts`) started with
  `--preload scripts/gate/e2e-coverage-preload.ts` (`tests/support/e2e/router-process.ts`). A daemon must exit through
  a normal exit path (SIGTERM is handled), never a hard kill, or its coverage is lost. Upstreams are the replay server
  `tests/support/e2e/upstreams.ts`, answering only from committed captures; browser logins use the fake `xdg-open`.
  The built bundle is run separately (`apps/router/tests/e2e/bundle.test.ts`); it cannot carry coverage.
  Code that only the translated cells (P5) reach is deferred by name in `scripts/gate/e2e-deferred.ts` (file, function
  or branch, each with phase and reason; an entry e2e covers, or whose name stops matching, fails the gate). The list
  must be empty when P5 is done ([R1 option B](docs/reference/2026-10-11-11-43-p4-e2e-coverage-r1.md)).
- **Hermetic test hooks** (only with all four upstream seams set; validated; read only by `main()`):
  `INFERENCE_ROUTER_TEST_PLATFORM`, `INFERENCE_ROUTER_TEST_UPSTREAM_IDLE_MS`, `INFERENCE_ROUTER_TEST_LOCK_TIMEOUT_MS`,
  `INFERENCE_ROUTER_TEST_LOCK_STAT_VANISHES=1`, `INFERENCE_ROUTER_TEST_LISTEN_UNASSIGNED=1` (binds RFC 5737
  `192.0.2.1`, so listen fails). They exist only for paths no outside test can otherwise reach.
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
- e2e clients (devDependencies of `apps/router`): @anthropic-ai/sdk 0.133.0, @google/genai 2.28.0, openai 7.32.0

## 7. Docs
- Files under `docs/{plans,research,issues,reference,temp}` are named `YYYY-MM-DD-HH-MM-<name>.md`, using the system clock.
- Session records are `docs/sessions/<session-id>.md`.
- README, this file, plans and diagrams are kept in exact sync with the code and the measured results after every change.
