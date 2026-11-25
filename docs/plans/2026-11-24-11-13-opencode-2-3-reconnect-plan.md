# opencode 2.3.0: reconnect to the proxy, and keep the whole ecosystem working

## Why

opencode on this machine (Homebrew, **v2.3.0**) shows no `ap-*` provider except a hand-made `ap-openrouter`, so it does
not use the proxy. The proxy, its documentation and its recon evidence target opencode **v2.1.1** (some rules
v2.0.26). opencode 2.1.1 → 2.3.0 is 2,037 commits, among them #62760 "stop applying well-known remote config after
logout", #60057 "stop merging credential metadata into model settings", #61170 "share provider endpoint and bearer auth
setup" and #54023 "coordinate credential refreshes across locations and processes".

## Findings (2026-11-24, measured)

| # | Finding | Evidence |
|---|---|---|
| F1 | The proxy is healthy: `/health` 200 with 7 providers, `/.well-known/opencode` and `/opencode/config.json` (7 providers, 1,003 models) answer. | `curl` on 127.0.0.1:4141 (daemon PID 59066, started 16:42Z) |
| F2 | **A clean opencode 2.3.0 works with the proxy.** In a throwaway `HOME`/XDG profile (own service port), `opencode auth login http://127.0.0.1:4141` → `opencode models` lists all 7 `ap-*` providers (22/300/13/8/146/44/470 models). | isolated run, cleaned afterwards |
| F3 | Against a fake echo server serving our manifest and config shape, 2.3.0 sends `Authorization: Bearer <token>` on the config fetch **and** on every model call, with or without a user-level `providers.ap-openrouter.body` block. `settings.apiKey: "{env:ACCOUNTS_PROXY_TOKEN}"` still resolves. | fake server log; v2.3.0 `packages/core/src/config.ts:182-215` |
| F4 | Every package we emit exists in 2.3.0 (`@opencode/ai/providers/{anthropic,google,openai,openai-compatible,openrouter}`), and so do the `compatibility` keys `supportsThinkingBlockBinding`/`supportsEffortUpdates`. | `git cat-file`/`git grep` on tag `v2.3.0` |
| F5 | OpenCode's request headers are unchanged in 2.3.0 and all are in `OPENCODE_CLIENT_HEADERS`. | v2.3.0 `session/model-request.ts:325-333`; `packages/core/src/domain/opencode-client.ts` |
| F6 | **The user's opencode has no credential for `http://127.0.0.1:4141`.** `opencode auth logout` at 16:09Z removed two (`cred_20e4e522…`, created by the 16:05Z login, and an older `cred_176eeb108…`). Since #62760 a source without a credential supplies nothing (`clearCached`), so every `ap-*` provider from the proxy disappeared. | `~/.local/share/opencode/opencode.db` table `credential`; `opencode.log` lines 199650, 200903, 200906 |
| F7 | At 16:06Z, 25 s after the login, `opencode run -m ap-openrouter/nvidia/nemotron-3.5-lightning:free` hit the proxy **without any `Authorization` header** → 401 `missing or invalid accounts-proxy token`. The config fetches of the same minute carried the right Bearer (sha256 prefix `d902852f6f01`). The long-lived service `run=e26e77f3`, up since before the login, served that run. | proxy exchange log `50040-usage.44.jsonl` (`c-51a84924…`); `opencode.log` 199667 |
| F8 | Workaround in place: an opencode credential `ap-openrouter` (16:40Z) whose key **equals the proxy token**, plus the `providers.ap-openrouter.body` block in `~/.config/opencode/opencode.jsonc`. It makes `ap-openrouter` half-work outside the well-known path and hides the real state. | `credential` table; `opencode.jsonc:456-462` |
| F9 | At 14:33Z opencode timed out after 15 s on `/.well-known/opencode` and `/opencode/config.json`, routes that should answer at once; at 16:41Z ECONNREFUSED (no daemon; 8 daemon starts between 16:01Z and 16:42Z). The 14:33Z window has rotated out of `.cache/logs/`. | `opencode.log` 174046-174047, 204193 |

**Working diagnosis.** There are two faults. (a) *The present state:* the logout left opencode with no proxy credential
(F6), so no provider loads. (b) *The original symptom:* in the long-lived service, right after login, the model call was
built without the key (F7). The leading hypotheses for (b): H1, the service kept a config resolved before the credential
existed (a source with no credential, then a model whose `apiKey` substituted to empty) and did not rebuild the provider
on `credential.updated`. H2, the older duplicate credential `cred_176eeb108…` (legacy `wellknown` import) was the one
picked by `credentials.list(...).at(-1)` in another code path. H3, a daemon restart during the run (F9). (b) is not
reproduced yet; F2/F3 show that a fresh service does not have it.

## What

- W1. **Restore** the user's opencode: one valid credential for `http://127.0.0.1:4141`, all 7 `ap-*` providers, a
  real inference through each provider family, and the workaround (F8) removed.
- W2. **Reproduce and pin down** fault (b) in a throwaway profile, and record it with its exact cause (issue file).
  The proxy cannot set the client's header, but it can make the failure readable and documented.
- W3. **Make the proxy say why** when a request has no token: the 401 names the missing `Authorization`/`x-api-key`
  and points at the fix (`opencode auth login http://127.0.0.1:4141`, the token command). Body shape unchanged
  (`unauthorized`); the API reference and OpenAPI are updated.
- W4. **Move the evidence base to opencode 2.3.0**: the client-setup reference, the code comments and the wire-law rows
  that say "opencode v2.1.1" are re-checked against tag `v2.3.0` and updated where 2.3.0 is verified to behave the
  same. Recon parity runs again for the opencode cells (Console, Go, ChatGPT plan usage).
- W5. **Daemon stability** (F9): find why the daemon restarted 8 times in 40 minutes and why the well-known routes
  stalled for 15 s.
- W6. **Whole ecosystem check**: opencode, pi (`/.well-known/pi`, `apps/pi-extension`), Claude Code (Messages) and the
  SDK clients of the e2e tier, each through the running daemon, with one recorded call per format × provider family.

Out of scope: changing opencode or the plugins (§4 Plugins); OpenCode Console sign-in of opencode itself (`SignedOut`
warnings are opencode's own `opencode` provider, not the proxy's); the cheapest-model routing plan in progress.

## How

| Step | Change / action | Verified by |
|---|---|---|
| S0 | **Back up** `~/.local/share/opencode/opencode.db` and `~/.config/opencode/opencode.jsonc` (copy with date suffix). Nothing is deleted without the backup. | backup files exist |
| S1 | **Restore (W1).** Stop the long-lived opencode service (`opencode service stop`), make sure one daemon listens on 4141 (`bun run proxy serve`), then `opencode auth login http://127.0.0.1:4141` and start opencode fresh. | `opencode models \| grep ^ap- \| cut -d/ -f1 \| uniq -c` shows 7 providers |
| S2 | **Remove the workaround (F8)** after S1 passes: `opencode auth logout ap-openrouter` (the token-valued key); keep the `body` block (F3 shows it merges safely). | `credential` table; an `ap-openrouter` call still answers |
| S3 | **Live smoke (W1)**, one short call each: `ap-claude` (Messages), `ap-openai` (Responses), `ap-antigravity` (Gemini), `ap-openrouter` (Chat), `ap-opencode` and `ap-opencode-go` (one free/cheap model each), `ap-cheaper-inference`. Every exchange in `.cache/logs/*-usage.jsonl` shows a Bearer whose sha256 prefix matches the token. | exchange log, status 200 each |
| S4 | **Reproduce fault (b) (W2)** in a throwaway profile (own `HOME`/XDG and service port; the 49374 clash is real). Sequence: start the service → `opencode run` against `ap-*` (no credential) → `auth login` → `run` again in the **same** service; variants: H2 (seed a legacy `auth.json` `wellknown` entry before first start), H3 (restart the daemon mid-session). Model calls go to a local echo server; no account is used. | echo log shows which step drops `Authorization` |
| S5 | Write `docs/issues/<ts>-opencode-2-3-missing-bearer.md` with the cause, the opencode source lines (tag `v2.3.0`) and the user-side remedy. If it is an opencode bug, the issue states it; reporting upstream is the user's decision. | issue file; docs lint |
| S6 | **Readable 401 (W3).** In the token check (`apps/proxy/src/adapters/inbound/http/`), distinguish *absent* from *wrong* credentials in `error.message` (same `type`/`code`, constant-time comparison kept); add the hint for opencode/pi. Update unit + component + e2e tests and the API/OpenAPI references. | `bun run verify`, 100% coverage |
| S7 | **Evidence to 2.3.0 (W4).** For each "opencode v2.1.1/v2.0.26" citation (`zstd-content-encoder.ts`, `opencode-client.ts`, `opencode-config-codec.ts`, `opencode-variants.ts`, `openai-provider.ts`, `provider-openai/domain/constants.ts`, `provider-opencode/domain/opencode.ts`, client-setup §6), diff the cited opencode file between `v2.1.1` and `v2.3.0`; change the citation where it is equal, open a sub-step where it differs (variants, zstd, the 16 ChatGPT ids). | per-file diff table in the issue/record |
| S8 | **Recon parity on 2.3.0 (W4).** New recon runs with opencode 2.3.0 for the Console, Go and ChatGPT cells (`bun scripts/recon/cli.ts run opencode …`, then `parity`). Gaps become wire-law updates in AGENTS.md §3 with their capture. Needs the Linux recon host (bubblewrap); on this Mac only the source diff of S7 is possible. | parity report, gap count 0 |
| S9 | **Daemon stability (W5).** Read `.cache/logs/2026-11-24-*-proxy.log` and the shell history/launcher for the 8 starts at 16:01–16:42Z (short logs of 2–14 lines suggest `EADDRINUSE`/restarts by a tool); measure `/.well-known/opencode` latency under load (the model-list background fetch must not block it). Fix if the proxy is at fault; else document. | latency < 100 ms under a model refresh; cause recorded |
| S10 | **Ecosystem check (W6).** pi: `/.well-known/pi`, `GET /pi/models.json`, one call through the extension; Claude Code: one Messages call with `ANTHROPIC_BASE_URL`; `bun run test:live` (real accounts tier) with the user's consent. | live tier report |
| S11 | Docs in step: README, AGENTS.md (§3 opencode rows, plan list), client-setup §6 (2.3.0, the logout pitfall, the service-restart step), the session record. | docs-in-step test, docs lint |
| S12 | Full gate `bun run verify`; secret audit of the diff (no token, no credential value from `opencode.db`); commit. | gate output, commit hash |

## Decisions needed from the user

- D1. S1–S2 touch your real opencode (service restart, a logout of the `ap-openrouter` key). Go ahead?
- D2. S6 changes the 401 message text (wire-visible, body shape unchanged). Accept?
- D3. S8 needs the Linux recon host and fresh interactive logins inside the profiles. Schedule now or later?
- D4. S10's live tier uses real quota on every provider. Run it?
- D5. If S4 shows an opencode bug, should it be reported upstream (from your account)?

## Acceptance

- Your opencode lists all 7 `ap-*` providers after a fresh start and answers through each of them (S3), with no
  `ap-openrouter` key credential left.
- Fault (b) is reproduced or ruled out with recorded evidence, and the remedy is in the client-setup reference.
- A request without a token gets a 401 that says so and how to fix it.
- No "opencode v2.1.1" citation remains unchecked against 2.3.0; every changed rule cites its capture or source line.
- `bun run verify` passes with 100% coverage on every tier; docs lint and docs-in-step pass.
