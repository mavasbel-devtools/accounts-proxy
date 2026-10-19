# P7 — documentation sweep

Extends [plan v4](2026-10-11-22-11-completion-plan.md) §5 (P7) and the [main plan](2026-10-06-00-23-inference-router-plan.md);
nothing earlier is replaced. Approved by the user on 2026-10-18 ("Could we proceed?", after the proposal to write the
P7 plan at the close of P6).

## 1. Starting point (2026-10-18 22:09, commit 78498d5)

Plan v4 §5 P7 asks for: README how-tos (Anthropic, OpenAI Chat + Responses, Google SDKs, Claude Code via
`ANTHROPIC_BASE_URL`, OpenAI-compatible tools), the diagram (components, flows, renewal under locks, matrix), AGENTS.md
and the plan statuses. What already exists, measured on 78498d5:

| P7 item | State at 78498d5 |
|---|---|
| SDK how-tos (Anthropic, OpenAI Chat + Responses, Google) | [client setup](../reference/2026-10-17-19-26-client-setup.md) §2 (constructor options; run by the e2e tier) |
| Claude Code via `ANTHROPIC_BASE_URL` | client setup §4 (measured live, L3) |
| OpenAI-compatible tools | **missing**: nothing says how a tool that configures an SDK from its environment reaches the proxy |
| README how-tos | README has a quick start and links the references; no per-client entry point |
| Diagram: components | `docs/architecture.drawio`, one page "Components (2026-10-16; P5 cancelled)"; every class name on it exists in the code (checked 22:09: 139 names, the only non-code words are the product names ChatGPT, GenAI, OpenAI, OpenCode) |
| Diagram: flows, renewal under locks, matrix | **missing** |
| A check keeping the diagram in step with the code | **missing** (docs lint only checks that a `.drawio` is an `<mxfile>`) |
| AGENTS.md | §1 still calls `opencode` "OpenCode Zen" (the Console migration of 2026-10-12 moved it to `opencode.ai/inference`); the header links neither the 2026-10-16 plan nor P6 |
| Plan statuses | the main plan and plan v4 still say "IN EXECUTION" with no line for P6/P7 |

## 2. Steps

| Step | Work | Status |
|---|---|---|
| P7-1 | **Environment-configured clients.** The pinned SDKs read their base URL and key from the environment (sources in `apps/proxy/node_modules`, cited by file and line): `@anthropic-ai/sdk` 0.133.0 `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, sent as Bearer); `openai` 7.32.0 `OPENAI_BASE_URL`, `OPENAI_API_KEY`; `@google/genai` 2.28.0 `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). An e2e test builds each SDK with **no options** and only these variables, against the replay daemon. Client setup gets a section "From the environment (tools built on the SDKs)" stating only what the test proves | done: `apps/proxy/tests/e2e/daemon.test.ts` "SDKs configured only from the environment" (3 tests, 5 SDK builds); client setup §3 |
| P7-2 | **README how-tos.** A "Use it from" table, one row per client (Anthropic SDK, OpenAI SDK Chat and Responses, Gen AI SDK, environment-configured tools, Claude Code, opencode, HTTP), each linking its client-setup section; the facts stay in client setup (each fact stated once, C7) | done: README "Use it from" |
| P7-3 | **Diagram.** `docs/architecture.drawio` gets three pages next to "Components": **Request flow** (client → `NodeHttpServer` → `RouteHandler` token check → codec route → `PassthroughService` alias/provider/native-format check → `ProviderPort.passthrough` → session → upstream → answer streamed back, and where each error comes from), **Renewal under locks** (`OAuthSessionBase.active`/`forceRenew`: single flight, `FileLock` `<data>/locks/<provider>-refresh.lock`, re-read, token endpoint, `CredentialStorePort.update` under `accounts-<provider>`, `needsLogin`, cooldown; the constants with their values), **Format × provider matrix** (the README's matrix). The Components page is brought to the code (`buildRoutes`) | done: four pages; Antigravity also renews once on a 401 (`with-active.ts`, `antigravity-runner.ts`), stated on both pages |
| P7-4 | **Diagram in step.** `apps/proxy/tests/unit/docs-in-step.test.ts` gains: every code name on the diagram is declared in a source file (product names excepted by an explicit list); the matrix page equals the README matrix; every constant the renewal page states has the code's value | done: 4 diagram tests + 1 test that the SDK lines cited in client setup §3 read the named variables; each made to fail by an injected wrong value (a misspelt class name, `pollMs = 51`, a changed README matrix cell) before being restored. Also: the docs lint now checks `#fragment` links against the target's headings (34 existing fragment links resolve; an injected wrong one fails) |
| P7-5 | **AGENTS.md** §1 `opencode` described as the OpenCode Console's inference gateway; header links the 2026-10-16, P6 and P7 plans; §7 names the diagram check | done; also §4 Sessions: Claude **and Antigravity** retry once after renewing on an upstream 401 (was: Claude) |
| P7-6 | **Plan statuses.** A dated status line (added, nothing rewritten) on the main plan and plan v4: P6 done, P7 done, next P8 | done: main plan §7 status record, plan v4 record |
| P7-7 | Session record; `bun run verify`; secret scan; commit; push | done: `bun run verify` GATE PASS (715 unit/component, 224 e2e, 100% coverage on every measure; docs lint 49 files) |

## 3. Out of scope

- No code behaviour changes. No live calls: everything in P7 is checked by the hermetic tiers.
- Clients that were never run against the proxy (other languages' SDKs, tools not tested) are not documented
  (evidence only).
