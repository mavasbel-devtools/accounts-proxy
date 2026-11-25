# Paired MITM capture: agy CLI vs proxy upstream envelope (Antigravity Gemini)

- Plan: `/Users/mavasbel/.opencode/plan/2026-11-23-15-52-agy-vs-proxy-envelope-capture.md`
  (SHA-256 `bcbf09593525275623ea9e41657933c615601a946be7e5ab44c7ed52885fde78`).
- Date: 2026-11-23. Prompt: `Hi`. Model: `gemini-3.8-flash-medium`. Project: `aicode-consumers`.
- Verdict: **`inconclusive`** (no proxy defect demonstrable from this pair; see §4).

## 1. Baseline (Step 0.2, read 2026-11-23T22:04:59Z)

- Daemon: `bun` pid 80467 LISTEN on 127.0.0.1:4141 (untouched throughout).
- Quota: Gemini 3.8 Flash weekly 100% (resets 2026-11-30T22:04:59Z), 5-hour 100%
  (resets 2026-11-24T03:04:59Z). Claude/GPT: weekly 99%, 5-hour 100%.
- Same-day tally: upstream `streamGenerateContent` 20× 429 (19× medium, 1× sonar),
  first 17:32:27Z, last 21:10:57Z; zero generate-200s after the 14:52Z re-probe.

## 2. Interception path (Steps 1.1–1.2)

- mitmproxy 9.0.1 in plan scratch (venv, no system install).
- Attempt 1: `no-flows` — agy honored `HTTPS_PROXY` (13 CONNECTs) but (A) was never logged in
  (`authentication timed out`, no `~/.agy`) and (B) rejected the MITM CA (13× cert errors).
  Transparent mode correctly skipped (fixes neither).
- User executed: interactive `agy models` login (listed, incl. `gemini-3.8-flash-medium`) +
  `sudo security add-trusted-cert … /Users/mavasbel/.mitmproxy/mitmproxy-ca-cert.pem`
  (CN=mitmproxy, 2026-11-21 → 2036).
- Attempt 2 (user-authorized corrected order `agy --model … --project … -p "Hi"`; plan-literal
  `-p`-first order exits 2): `flows-captured` — 15 flows to `daily-cloudcode-pa.googleapis.com`,
  agy direct HTTP 200. Port 8899 freed, no strays.

## 3. Paired capture (Steps 2.1–2.2, window 22:29:30Z → 22:39:30Z UTC, met)

| # | path | id | time (UTC) | upstream status |
|---|---|---|---|---|
| golden (agy direct) | `captures/agy-direct-request.json` (41924 B) | `agent/58092d9b-…/1795472954930/3a054597-…/1` | 22:29:30Z | 200 |
| proxy (via :4141) | `captures/proxy-upstream-request.json` (582 B, complete wire bytes per log) | `u-8916793e-…`, exchange `c-3853909c-…` | 22:30:15Z | **200** |

Enforcement cleared mid-window: proxy path 200 at 22:30:18Z after 429s through 21:10Z,
advertise 100% throughout. Token-prefix grep over all proxy artifacts: 0 hits.

## 4. Diff + verdict (Step 3.1, main-session corrected)

Byte-identical envelope fields: top-level key order
(`project, requestId, request, model, userAgent, requestType`), `project`,
`model`, `userAgent` (`"antigravity"` both), `requestType`, shared request-key order,
`sessionId` type (decimal string), `model_enum` (`MODEL_PLACEHOLDER_M319`), `used_*`
flags, `maxOutputTokens` 65536. Run-scoped (must differ, internally consistent):
`requestId` segments/counters (`…/1` vs `…/3`), `sessionId` values, `trajectory_id`,
`last_step_index` (0 vs 2).

Genuinely present in agy bytes but absent from proxy wire bytes **for this pair**:
`systemInstruction` (~19.9k-char harness identity), `tools` (functionDeclarations),
prompt wrapper (`<USER_REQUEST>…` + metadata), `thinkingConfig`, cascade labels —
attributable to different client input (bare `curl "Hi"` vs agy's harness), NOT to
proven proxy alteration. Whether the proxy forwards client-supplied
systemInstruction/tools is UNTESTED (needs its own step).

Verdict `inconclusive` per the plan trichotomy: no proxy-emitted divergence exists,
and plan-literal `identity-enforcement` (simultaneous proxy-429-while-direct-200)
cannot be claimed — both paths served 200. Standing result: identity-bearing fields
match exactly; enforcement is time-varying upstream; no proxy defect demonstrable.

## 5. Consequences

1. Prior plan verdict `recovered` should be revised to **transient/intermittent upstream
   enforcement** (429s 17:32–21:10Z → 200s from ~22:30Z, advertise 100% throughout).
   Separate decision, not made here.
2. No proxy code change is justified by this pair.
3. Follow-up (new step/plan, not this one): send a proxy request WITH systemInstruction/tools
   and check the upstream log form, to close the forwarding question.
4. Reuse: `agy --model … --project … -p "…"` order; `HTTPS_PROXY=` regular mode works once
   agy is logged in and the mitm CA is trusted; `~/.mitmproxy/mitmproxy-ca-cert.pem` persists.
