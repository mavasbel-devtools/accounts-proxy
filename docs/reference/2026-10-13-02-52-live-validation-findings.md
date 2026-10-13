# Live validation of all seven providers (L0–L4): findings

Plan: [2026-10-13-01-42 live validation](../plans/2026-10-13-01-42-live-validation-plan.md). Run on 2026-10-13 against
the user's own accounts in `~/.local/share/inference-router/` (0700; every account file 0600). One request at a time,
2 s apart. No provider answered 429 or 402.

## Generated evidence

| Step | Script | Output |
|---|---|---|
| L1 (full matrix) | `scripts/evidence/live/l1-live-matrix.ts` | [01-50 table](2026-10-13-01-50-l1-live-matrix.md) |
| L1 rerun after fixes (openai, Zen Chat, L2 Console) | same, `--only=openai-resp,opencode-chat,l2-opencode` | [01-59 table](2026-10-13-01-59-l1-live-matrix.md) |
| L1 rerun after the Gemini-cell fix | same, `--only=antigravity --scenarios=s5,s5b` | [02-00 table](2026-10-13-02-00-l1-live-matrix.md) |
| Zen Chat check | `scripts/evidence/live/l1-zen-chat-check.ts` | `tests/fixtures/captures/p0-live/l1/opencode-z*.json` |
| MCP schemas on Antigravity | `scripts/evidence/live/l1-antigravity-json-schema.ts` | `tests/fixtures/captures/p0-live/l1/antigravity-j*.json` |
| L4 control plane | `scripts/evidence/live/l4-control-plane.ts` | `tests/fixtures/captures/p0-live/l4/*.json` |

All captures are redacted and secret-scanned before they are written; token-endpoint exchanges are never written. The
reruns overwrote the captures of the cells they repeated, so the 01-50 rows of `openai-resp`, `opencode-chat` and
`antigravity-* s5/s5b` describe the behaviour before the fixes below; their current captures are the reruns'.

## L0: status

All seven providers have an active account. Live model lists: claude 14, antigravity 24, openai 7, openrouter 459,
opencode 84, opencode-go 39, cheaper-inference 91. Quota: antigravity (Gemini 91% weekly, Claude/GPT 100%), openrouter
(key usage 0, no limit), cheaper-inference (wallet USD 13.77). `quota openai` and `quota claude`: "does not report
usage" (no usage endpoint in their evidence).

## L1: the native cells through the daemon with the official SDKs

Every native cell answered the plain, streamed, three-turn (the code word recalled), tool round trip and MCP-schema
scenarios, after the fixes F1–F3: `claude` (Messages), `antigravity` (Gemini, Gemini and Claude models), `openai`
(Responses), `openrouter` (Chat, Messages, Responses on a `:free` model), `opencode` (Chat `glm-5.1`, Messages, Gemini,
Responses), `opencode-go` (Chat, Messages, Responses), `cheaper-inference` (Chat, Messages, Responses). An unknown model
is the provider's own error passed through (Claude 404, OpenAI 400, OpenRouter 400, OpenCode 400 "Model is
unavailable", Cheaper 404), except Antigravity, whose catalog answers it in the router (404 `unknown model`).

## L2: forced renewals

| Session | Result |
|---|---|
| openai | access token replaced, refresh token rotated, 60 min lifetime; the next request 200 |
| OpenCode Console | access token replaced, refresh token rotated, workspace kept, 30-day lifetime; the next request 200 |

Both match their documented rotation (OpenAI T3; Console Z18). The first openai and claude requests of the day also
renewed expired access tokens on their own (router log 07:39:37–39 UTC).

## L3: real clients (temporary configuration under /tmp/opencode only)

A minimal stdio MCP server (`read_file`, input schema in the MCP SDK's draft-07 shape) was attached to both clients.

| Client | Route | Models | Result |
|---|---|---|---|
| Claude Code 2.1.29 (`claude -p`, `CLAUDE_CONFIG_DIR` temporary, `--strict-mcp-config`) | Anthropic Messages | `claude/claude-haiku-4-5-20251001`, `openrouter/nvidia/nemotron-3.5-lightning:free`, `opencode/claude-haiku-4-5`, `opencode-go/qwen3.8-flash`, `cheaper-inference/gpt-5.4-nano` | MCP tool called, answer correct; `--resume` and `--continue` turns recalled the earlier tool result |
| opencode 2.0.26 (`run --standalone --auto`, every XDG directory temporary) | Chat (`@ai-sdk/openai-compatible`), Responses (`@ai-sdk/openai`), Messages (`@ai-sdk/anthropic`), Gemini (`@ai-sdk/google`) | `openrouter`, `opencode/glm-5.1`, `opencode-go` (Chat and Responses), `cheaper-inference`, `openai/gpt-5.6-luna`, `claude`, `antigravity/gemini-3.5-flash-lite` | MCP tool called through opencode's code mode, answer correct; a `--continue` turn recalled the file |

## Findings and what was done

| # | Finding (evidence) | Change |
|---|---|---|
| F1 | ChatGPT plan usage ends every stream with `response.completed` whose `response.output` is `[]`; the items arrive only in `response.output_item.done` (capture `l1/openai-resp-s2-plain-stream.json`). Non-streamed answers had no output, and the official SDK's `finalResponse()` was empty. | Rule I6: the terminal response gets the streamed items (in `output_index` order), in the aggregated answer and in the stream (every other frame unchanged). Rerun 01-59: every scenario answers. |
| F2 | The Gen AI SDK sends every tool whose schema has `$schema` (every MCP tool, `mcpToGeminiTool`) as `parametersJsonSchema` (`@google/genai` 2.28.0 `tTool`). The Gemini cell refused it; with `x-router-lossy` the tool lost its parameters (a Claude model then called it without arguments). Antigravity itself accepts `parametersJsonSchema` on Gemini and Claude models (j1/j2: correct calls) and refuses the same schema as `parameters` (j3/j4: 400 `$schema`, `exclusiveMinimum`). | Decision 4 (measured, then decided): `parametersJsonSchema` travels unchanged; `parameters` keeps law 5. Rerun 02-00: strict and lossy both call the tool with its argument. |
| F3 | OpenCode Go refuses requests without `x-opencode-session` (400 `MissingSessionID`); Claude Code sends no such header (captured headers of claude-cli 2.1.29), only `metadata.user_id` ending in `_session_<uuid>`. | Rule Z24: when the client sends none, the router sends the conversation's own id (Claude Code's session, the Responses `prompt_cache_key`), else `rtr_` + a 64-bit FNV-1a hash of the first user turn (stable across a conversation, since clients resend history). Claude Code → Go then answered 200. |
| F4 | OpenCode Zen `deepseek-v4-flash` and `kimi-k2.6` answer 404/410 "Upstream request failed: Endpoint is unavailable." on the documented path and on models.dev's base, while `glm-5.1` answers 200 on the same path (`l1-zen-chat-check.ts`). | None in the router: the vendor's availability, passed through unchanged. The matrix uses `glm-5.1`. |
| F5 | opencode's Responses provider sends `max_output_tokens`, which plan usage refuses (documented, I3): the router answers 400 `unsupported_feature`. | None (strict translation). With `options.headers: {"x-router-lossy": "1"}` in opencode's provider config the field is dropped and reported; the README says so. |
| F6 | A client that abandons a request (opencode cancels side requests) made the router log an ERROR with the abort's stack. | An abandoned request is not reported as a router failure. |
| F7 | `models openai` printed `output undefined` (the OpenAI list states no output limit). | Each limit is printed only when the catalog states it. |
| F8 | `status` with no daemon read "upstream 127.0.0.1:4141 could not be reached". | It reads "nothing is listening: …". |
| F9 | The AI SDK stops reading after `response.completed`; the openai stream-end log line was then never written. | The line is written in every case ("stream end" or "stream closed by the client"). |
| F10 | The L2 summary of the first run read the Console account's fields at the wrong depth ("unchanged"); the router log (07:50:51 "access token rotated") and the account file showed the renewal had happened. | Script fixed; the 01-59 rerun reports the rotation correctly. |

## L4: recordings into e2e tests

The e2e replay now answers from these captures: the live OpenAI model list and Responses streams (plain and tool
loop), the Console's user, organisations and workspace config, and Cheaper Inference's account and wallet. Grants are
never recorded, so token answers in the replay carry the fields the router reads (OpenAI token reference; the
Console's device-token answer) and the scopes the live sign-in granted; the OpenAI ID token has the live claim names
and is signed by the replay's own key (OpenAI's key set is committed in `l4/openai-jwks.json`). New e2e files:
`apps/router/tests/e2e/openai.test.ts` (sign-in, ID-token and key-set checks, the Responses cell with I6, renewal,
catalog) and `apps/router/tests/e2e/console.test.ts` (device login approved after `slow_down`, Console session renewal
and refusal, Cheaper key and wallet). Every `P4.5-live` and `P4.6-live` deferral left `scripts/gate/e2e-deferred.ts`;
what remains is P5 only.
