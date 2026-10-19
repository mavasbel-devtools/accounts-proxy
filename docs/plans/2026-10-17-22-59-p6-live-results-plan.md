# P6 — live results of every native cell (timing and incremental streaming)

Extends [plan v4](2026-10-11-22-11-completion-plan.md) §5 (P6) and the [main plan](2026-10-06-00-23-inference-router-plan.md)
§4 P6; nothing earlier is replaced. Approved by the user on 2026-10-17 ("Please, and could we proceed?", after the
proposal to write the P6 plan).

## 1. Starting point (2026-10-17 22:59, commit 2079b9f)

- P5 is cancelled (plan 2026-10-16 D1-A): the proxy serves native cells only; every other provider × format pair is
  400 `unsupported_feature`. P6's "all 12 cells" (plan v4) therefore becomes **every native cell** of the seven
  providers. The translated cells are out of scope; that is the only change to P6's scope.
- Pass/fail of the native cells was measured live on 2026-10-13 (L1–L3,
  [findings](../reference/2026-10-13-02-52-live-validation-findings.md)) and again for one request per provider after
  the rename (R7, 2026-10-17). Not yet measured: what P6 asks for in addition — **time to first token, inter-chunk
  timing and the proof of incremental streaming** — and the code since 2026-10-13 (rename, model catalog, rule I7).
- The user's daemon (pid 519527) was started at 20:13, before rule I7 (commit 2079b9f, 20:48), so it runs older code.
- Every model below is in the daemon's `GET /proxy/v1/models` at 22:59 with the format used here.

## 2. What is measured

Through the user's own daemon (`bun run proxy serve` on `127.0.0.1:4141`, the production process, restarted on
2079b9f), with raw HTTP from the client side, so the times are what a client sees: no SDK buffering in between.

| Cell | Provider / model | Route |
|---|---|---|
| claude-msg | `claude/claude-haiku-4-5-20251001` | Anthropic Messages |
| antigravity-gem | `antigravity/gemini-3.5-flash-lite` | Gemini (`?alt=sse`; one run as the JSON-array stream) |
| antigravity-claude | `antigravity/claude-sonnet-5-5-low` | Gemini |
| openai-resp | `openai/gpt-5.6-luna` | OpenAI Responses |
| openrouter-{chat,msg,resp} | `openrouter/nvidia/nemotron-3.5-lightning:free` | Chat, Messages, Responses |
| opencode-chat | `opencode/glm-5.1` | Chat |
| opencode-msg | `opencode/claude-haiku-4-5` | Messages |
| opencode-gem | `opencode/gemini-3.5-flash-lite` | Gemini |
| opencode-resp | `opencode/gpt-5.4-nano` | Responses |
| go-{chat,msg,resp} | `opencode-go/glm-5.3-flash`, `qwen3.8-flash`, `gpt-5.6-luna` | Chat, Messages, Responses |
| cheaper-{chat,msg,resp} | `cheaper-inference/gpt-5.4-nano` | Chat, Messages, Responses |

The models are the ones of the 2026-10-13 L1 matrix (`scripts/evidence/live/l1-live-matrix.ts`), so the results compare.

Per cell: **three streamed runs and one non-streamed run** of the same prompt ("Count from 1 to 40, separated by
spaces. Output only the numbers."); plus one `count_tokens` call on `claude` and `cheaper-inference` (the two
providers with a counting endpoint). About 72 requests in total, one at a time, 2 s apart. A 429 or 402 stops that
provider's remaining requests (no retry, no account switch, AGENTS.md §4).

Recorded per request (client clock, `performance.now()`):

- HTTP status, `content-type`, `x-proxy-dropped`, the request id header;
- time to the response headers; time to the first event; **time to first token** (the first event that carries answer
  text: Messages `text_delta`, Chat `delta.content`, Responses `response.output_text.delta`, Gemini `parts[].text`
  that is not a thought); time to the last event; total time;
- the network reads that carried answer text: their count, the span from the first to the last, and the median and
  maximum gap between them;
- whether the terminal event arrived (Messages `message_stop`, Chat `[DONE]`, Responses `response.completed`, Gemini a
  candidate with `finishReason`), and whether the text is exactly the numbers 1–40.

Pass criteria (stated before the run, applied by the script):

- **pass**: status 200, the terminal event (streamed) or a complete body (non-streamed), non-empty answer text;
- **incremental** (streamed only): the answer text arrived in at least 3 separate network reads, and the first one
  arrived before the last event. A cell whose text came in fewer reads is reported as "not incremental" with the
  numbers; nothing is inferred beyond them;
- the text check (1–40 exactly) is reported, not a pass criterion: it measures the model, not the proxy.

## 3. Steps

| Step | What | State |
|---|---|---|
| P6-0 | This plan | done |
| P6-1 | `scripts/evidence/live/stream-timing.ts` (pure: per-format text extraction, terminal event, read statistics) with unit tests in `scripts/tests/unit/`; the runner `scripts/evidence/live/p6-live-results.ts` (`--base`, `--only=`, `--runs=`); dry run against an e2e replay daemon | done: 9 unit tests; `--replay` dry run 14/14 pass (claude, antigravity) |
| P6-2 | **User:** restart the daemon (`bun run proxy serve`) so it runs 2079b9f | done (16:31, pid 3289100) |
| P6-3 | Live run; results document `docs/reference/<ts>-p6-live-results.md` (generated, secret-scanned) | run 1 done: [results](../reference/2026-10-18-18-37-p6-live-results.md); final run after the F10 fix (P6-6) |
| P6-4 | Findings: any failure or non-incremental cell is investigated to its cause; a proxy defect is fixed with tests; a provider behaviour is documented with the evidence | done: F10 fixed; cheaper-inference burst is the upstream's |
| P6-5 | README, AGENTS.md (if a law changes), providers reference, plan v4 record, session record; `bun run verify`; commit; push | done (79a4a36 for run 1 and F10; the final run's records with P6-6) |
| P6-6 | Added 2026-10-18 (§6): after the user restarts the daemon on the F10 commit, the full run again; the final results document | done: [final results](../reference/2026-10-18-20-07-p6-live-results.md) |

## 4. Safety

- Only the daemon's own routes are called; nothing outside the repository, `/tmp/opencode` and the documents is written.
  No captures are written (the timing is the evidence; L1 already holds the captures of these cells), so no response
  body is persisted beyond the short answer text, which the redactor scans before the document is written.
- No sign-in, renewal or account change is forced; a renewal the daemon makes on its own is normal operation.

## 5. Execution record

- 2026-10-17 22:59 plan written.
- 2026-10-17 P6-1 done: `stream-timing.ts` + 9 unit tests, the runner, `--replay` dry run (every claude and antigravity
  request passes; the replay answers at once, so its streams are not incremental, as expected). `writeDoc` now needs
  only the redactor. Waiting for P6-2 (daemon restart).
- 2026-10-18 18:37 P6-3 run 1 ([results](../reference/2026-10-18-18-37-p6-live-results.md)): 72 requests, no 429/402;
  71 pass, 1 fail (`claude` count_tokens 400 `max_tokens: Extra inputs are not permitted`); 50 of 51 streamed runs
  incremental (`cheaper-resp` #3 not; #1 only by the letter of the criterion).
- 2026-10-18 P6-4. Probes, both with captures under `tests/fixtures/captures/p0-live/p6/` (this amends §4, which said no
  captures: a fix needs its evidence, AGENTS.md §4):
  [count_tokens](../reference/2026-10-18-18-39-p6-count-tokens-probe.md) (c1 400 `diagnostics` also refused; c2–c4 200
  with only the spec's body parameters) → **deviation F10**: the Claude envelope leaves out `max_tokens`,
  `context_management`, `diagnostics`, `metadata` on count_tokens (`request-transform.ts`; parity test asserts the
  difference; the e2e replay now answers count_tokens from the p6 captures and refuses keys outside the spec);
  verified live through the production provider ([c5](../reference/2026-10-18-18-49-p6-count-tokens-probe.md): 200).
  [cheaper-inference Responses straight from the upstream](../reference/2026-10-18-18-47-p6-cheaper-responses-probe.md):
  run 3 of 4 also arrived in one burst, so the burst is the upstream's. The runner's request-id list lacked
  `x-ci-request-id` (fixed). Docs: AGENTS.md §3 row F10, format fields §1, providers reference.

## 6. Amendment 2026-10-18: final run

The user's daemon runs 2079b9f, before F10, so run 1 cannot show count_tokens passing through the daemon. After the
F10 commit the user restarts the daemon once more and the full run is repeated unchanged (P6-6); its document is the
final P6 result, run 1 stays as the record of the finding.
- 2026-10-18 20:07 P6-6 final run ([results](../reference/2026-10-18-20-07-p6-live-results.md)) on the user's daemon
  restarted at 19:59 on 79a4a36: 72/72 pass (count_tokens on `claude` 200), no 429/402, 50 of 51 streamed runs
  incremental. Findings, each probed with captures under `tests/fixtures/captures/p0-live/p6/`: `opencode-gem` stream#3
  arrived in 2 reads; `scripts/evidence/live/p6-upstream-probe.ts --via=proxy` serves the daemon's own request handling
  in-process (`buildRoutes`, extracted from `buildCli` for this) and records both sides of each request: the client
  read exactly the upstream's chunks in 6 of 6 runs, and the upstream's own chunk count varies (3–6), so the
  chunking is the upstream's ([probe](../reference/2026-10-18-20-11-p6-upstream-probe-opencode-gem-sse-via-proxy.md)).
  `cheaper-inference` count_tokens answers carry no `x-ci-request-id` upstream
  ([probe](../reference/2026-10-18-20-09-p6-upstream-probe-cheaper-count.md)). P6 is complete.
