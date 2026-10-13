# Live validation of all seven providers (L0–L4)

Extends [plan v4](2026-10-11-22-11-completion-plan.md) (P6 live validation, brought forward) and
[P4.6](2026-10-12-15-35-p46-gateway-providers-plan.md) step 5 / amendment A5. Nothing earlier is replaced.
Approved by the user on 2026-10-13 ("proceed as per your recommendations": decisions 1–4 below, all as recommended).

## Starting point (2026-10-13)

All seven providers have an account in `~/.local/share/inference-router/` (0700; account files 0600). Live through
the router so far: `claude` and `antigravity` only (P0-LIVE, P4 smoke). Not yet live through the router: `openai`
requests, OpenCode Console requests (sign-in done), `openrouter` and `cheaper-inference` requests (key check done).
Translated cells (P5) still answer 400 `unsupported_feature`; this plan tests native cells only.

## Steps

| Step | What | State |
|---|---|---|
| L0 | Status, no prompts: `account list`, `models`, `quota` for the seven providers | done |
| L1 | Through the real daemon (in-process `serve` over the recording transport, same composition root) with the official SDKs, one request at a time, 2 s apart: per provider a primary cell (plain non-streamed, plain streamed, a three-turn conversation, a tool round trip, an MCP-style tool definition, the same with `x-router-lossy: 1`, an unknown model) and one plain streamed request per other native format. Free models first (OpenRouter `:free`). A 429 or 402 stops that provider's remaining requests. Captures redacted and secret-scanned. | done (3 runs) |
| L2 | One forced token renewal each for `openai` and `opencode` (the Console session), then one request with the new token. Never a reuse of an old refresh token. | done |
| L3 | Real clients through the router with temporary configs under `/tmp/opencode` only: Claude Code (Anthropic Messages) and opencode (Chat / Responses), several turns with their tools. | done |
| L4 | Findings document; recordings → e2e tests (clearing the live-only deferrals where the recordings allow); docs; `bun run verify`; commit. | done |

## Decisions (user, 2026-10-13)

1. L0–L4 with a budget of about 70 small requests: yes.
2. L2 forced renewals (may cost one re-login each): yes.
3. L3 with real Claude Code and opencode, temporary configs only: yes.
4. MCP tool schemas on Antigravity: measure first (strict 400 vs `x-router-lossy: 1`), decide on evidence.

## Execution record

- 2026-10-13 02:52 L0–L4 done ([findings](../reference/2026-10-13-02-52-live-validation-findings.md)). About 85 provider
  requests in the matrix runs and checks, plus the real-client turns of L3; no 429 or 402. Fixed from the evidence: the
  OpenAI terminal output (I6), `parametersJsonSchema` on the Antigravity Gemini cell (decision 4, measured), the Go
  session id (Z24), abandoned requests logged as failures, `output undefined` in `models`, the `status` wording, the
  openai stream-end log line. All `P4.5-live` / `P4.6-live` deferrals left the e2e list (new e2e files `openai.test.ts`,
  `console.test.ts`); only P5 deferrals remain. Next: P5.
