# Recon R5 gap report: the proxy's upstream requests against the real clients'

Plan: [recon MITM capture plan §20](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md#20-amendment--r5-parity-tool-and-first-gap-report-2026-10-21-2044).
Capture ids are `<run>` + `seq`, as recorded in each capture's `index.json` and request record; the runs are in the
operator's recon store (`~/.local/share/accounts-proxy/recon/runs/`), not in the repository.

## 1. How the comparison is made

`bun scripts/recon/cli.ts parity <run-dir> <seq>...` (code: `scripts/recon/parity/`):

1. **Plane A** is the client's request as the recon addon recorded it: ordered header pairs with their case, exact body.
2. The request the client would send **to the proxy** is derived from it (the mapping is printed with every result
   below), and posted to a signed-in proxy daemon — the e2e harness: source entry, replay upstreams, fake-browser
   logins. No provider is contacted.
3. **Plane B** is the proxy's outbound request, recorded byte for byte by a TCP tap between the daemon and the replay
   upstream, so header order, case and duplicates are kept.
4. Both are canonicalised (`canon.ts`): the origin, `host`, `content-length`, credentials, identity fields, UUIDs,
   epoch timestamps, int64 session ids and message ids become named placeholders; everything else is compared.
   Arrays are aligned on equal elements before they are compared (`diff.ts`).
5. All captures of one conversation go through one daemon, in order, so per-session state (Antigravity's trajectory
   step counter and labels) evolves as it did for the client. Measured: with one daemon per request the step counter
   and `last_step_index` differed; with the conversation replayed in order they are equal.
6. When the proxy refuses the request as the client sent it, the refusal is recorded and the request is repeated with
   `x-proxy-lossy: 1`, so the rest can still be compared.

Unit tests: `scripts/tests/unit/recon-parity.test.ts` (canonical form, every difference kind, array alignment, the tap's
HTTP/1.1 parser with split reads and chunked bodies, both cell mappings, the report).

## 2. Results

| Capture run | Seq | Proxy (before R6) | Differences (before R6) | Proxy (after R6) | Differences (after R6) |
|---|---|---|---|---|---|
| `claude/2026-10-22-02-04-42/workflow` | 18 | refused | 23 | accepted | **0** |
| `claude/2026-10-20-22-26-06/workflow` | 14 | refused | 23 | accepted | **0** |
| `claude/2026-10-20-22-26-06/workflow` | 34 | refused | 23 | accepted | **0** |
| `claude/2026-10-20-22-27-09/workflow` | 15 | refused | 23 | accepted | **0** |
| `claude/2026-10-20-22-27-09/workflow` | 16 | refused | 24 | accepted | **0** |
| `antigravity/2026-10-21-23-59-49/login` | 3287 | accepted | 34 | accepted | 34 |
| `antigravity/2026-10-21-23-59-49/login` | 3306 | accepted | 34 | accepted | 34 |
| `antigravity/2026-10-21-23-59-49/login` | 3313 | accepted | 34 | accepted | 34 |
| `antigravity/2026-10-21-23-59-49/login` | 3343 | accepted | 34 | accepted | 34 |

## 3. Claude Code 2.1.304 (`claude` cell)

All gaps C1–C10 were closed in Phase R6 (plan §21). The table below records the initial findings and their resolution:

| # | Gap | Evidence | Resolution in Phase R6 |
|---|---|---|---|
| C1 | Claude Code's own request refused (7 new betas) | seq 18 | Allowed all 17 Claude Code 2.1.304 betas for `claude-opus-5-5` |
| C2 | Proxy reported Claude Code 2.1.280 / SDK 0.112.1 | seq 18 | Updated to 2.1.304 / SDK 0.128.0 |
| C3 | `x-stainless-os: Windows` on Linux host | seq 18 | Real platform passed (`Linux`) |
| C4 | Missing client headers (`X-Claude-Code-Session-Id`, `x-claude-code-prompt-id`, etc.) | seq 18, seq 16 | Added missing client headers |
| C5 | Extra header `x-cc-session-id` | seq 18 | Dropped `x-cc-session-id` |
| C6 | Header casing (`X-Stainless-*`) | seq 18 | Matched client's exact casing |
| C7 | Header order | seq 18 | Matched client's exact header order |
| C8 | `accept: text/event-stream` instead of `application/json` | seq 18 | Changed `accept` to `application/json` |
| C9 | Duplicated billing/identity blocks when client is Claude Code | seq 14, 18, 34 | Existing billing/identity blocks preserved as sent |
| C10 | Model list from `/v1/models` instead of `model_selector/cc` | plan §19.4 | Added `model_selector/cc` and startup reads |

Everything else in the body is equal on every compared request: `messages` (including the mid-conversation `system`
role), `tools`, `thinking`, `context_management`, `output_config`, `metadata` (identity masked), `diagnostics`,
`thread`, `max_tokens`, `stream`.

## 4. Antigravity 1.107.0 (`antigravity` cell)

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| A1 | `user-agent: antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)`; the client on this host sends `os_type=linux` | `antigravity/2026-10-21-23-59-49/login` seq 3287 | a platform the host is not |
| A2 | Tools: the client sends **14 `tools` entries with one `functionDeclarations` each**; the proxy merges them into one entry with 14 | seq 3287, 3306, 3313, 3343 | a different body shape on every tool turn |
| A3 | Transport headers: the client (Go) sends `transfer-encoding: chunked` and no `accept`, `connection` or `content-length`; the proxy (Bun) sends `accept: */*`, `connection: keep-alive`, `content-length` | seq 3287 | hop-level fingerprint |
| A4 | Header order: client `host, user-agent, authorization, content-type, accept-encoding`; proxy `accept-encoding, authorization, content-type, user-agent, host` | seq 3287 | observable order |
| A5 | Model list and control calls: the client calls `fetchAvailableModels`, `loadCodeAssist` and `listExperiments` repeatedly; the proxy fetches the catalogue on demand | plan §19.4 | cadence differs |

Equal on all four compared requests: `model`, `project`, `requestType`, `userAgent`, `requestId` (format and step
counter), `request.contents` (including `functionCall` / `functionResponse` in model-role contents),
`systemInstruction`, `generationConfig`, `toolConfig`, `sessionId` (format) and every `labels` entry.

## 5. Not covered here

- **opencode**: the proxy's opencode cells need a Console sign-in the e2e harness does not create; its parity cell is
  the next one to add.
- **TLS**: the ClientHello (JA3/JA4) is recorded on plane A since R2; plane B goes to a loopback HTTP tap, so the
  proxy's TLS fingerprint is not compared yet.
- **HTTP version**: both captured clients used HTTP/1.1 to these hosts; the proxy's loopback leg is HTTP/1.1 as well.
- **Responses**: this report compares requests. The proxy passes answers through (proxy API §3).
- **Side calls the client makes on its own** (Antigravity's `gemini-3.1-flash-lite` call, opencode's title call,
  telemetry, feature flags) are out of scope by the user's decision of 2026-10-21 (option A): the proxy does not
  generate traffic its client did not ask for.

## 6. Generated results

#### claude 2.1.304 (Claude Code) — capture `claude/2026-10-22-02-04-42/workflow` seq 18

Client request: `https://api.anthropic.com/v1/messages` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the captured headers in their order with the proxy token in `Authorization`, and the captured body with the model named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the HTTP stack.

**Refused as sent:** 400 `478 chars, sha256 936ca2dd7807: {"type":"error","error":{"type":"invalid_request_error","message":"claude (only …`. The rows below compare the request repeated with `x-proxy-lossy: 1`, which dropped `323 chars, sha256 4e8006dbd16e: anthropic-beta:per-turn-control-2026-07-01,anthropic-beta:mid-conversation-tool-…`.

23 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `accept` | `application/json` | `text/event-stream` |
| 2 | header-value | `user-agent` | `claude-cli/2.1.304 (external, sdk-cli)` | `claude-cli/2.1.280.b1a (external, sdk-cli)` |
| 3 | header-missing | `x-claude-code-session-id` | `<uuid>` | — |
| 4 | header-case | `x-stainless-arch` | `X-Stainless-Arch` | `x-stainless-arch` |
| 5 | header-case | `x-stainless-lang` | `X-Stainless-Lang` | `x-stainless-lang` |
| 6 | header-value | `x-stainless-os` | `Linux` | `Windows` |
| 7 | header-case | `x-stainless-os` | `X-Stainless-OS` | `x-stainless-os` |
| 8 | header-value | `x-stainless-package-version` | `0.128.0` | `0.112.1` |
| 9 | header-case | `x-stainless-package-version` | `X-Stainless-Package-Version` | `x-stainless-package-version` |
| 10 | header-case | `x-stainless-retry-count` | `X-Stainless-Retry-Count` | `x-stainless-retry-count` |
| 11 | header-case | `x-stainless-runtime` | `X-Stainless-Runtime` | `x-stainless-runtime` |
| 12 | header-case | `x-stainless-runtime-version` | `X-Stainless-Runtime-Version` | `x-stainless-runtime-version` |
| 13 | header-case | `x-stainless-timeout` | `X-Stainless-Timeout` | `x-stainless-timeout` |
| 14 | header-value | `anthropic-beta` | `492 chars, sha256 b04a02bc3b58: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` | `273 chars, sha256 82afd1eb713f: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` |
| 15 | header-missing | `anthropic-dispatch-id` | `v2d` | — |
| 16 | header-missing | `x-cc-atis` | `711efd76d10f17e5` | — |
| 17 | header-missing | `x-claude-code-prompt-id` | `<uuid>` | — |
| 18 | header-missing | `x-claude-code-request-class` | `main` | — |
| 19 | header-extra | `x-cc-session-id` | — | `<uuid>` |
| 20 | header-order | `headers` | `405 chars, sha256 526e1ef0d289: ["accept","authorization","content-type","user-agent","x-stainless-arch","x-stai…` | `405 chars, sha256 58f7f4f3dc2c: ["accept","authorization","content-type","user-agent","anthropic-beta","anthropi…` |
| 21 | body-length | `/system` | `4` | `6` |
| 22 | body-extra | `/system/+0` | — | `131 chars, sha256 aefc5e18cfda: {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.b1a; cc_en…` |
| 23 | body-extra | `/system/+1` | — | `{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."}` |

#### claude 2.1.304 (Claude Code) — capture `claude/2026-10-20-22-26-06/workflow` seq 14

Client request: `https://api.anthropic.com/v1/messages` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the captured headers in their order with the proxy token in `Authorization`, and the captured body with the model named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the HTTP stack.

**Refused as sent:** 400 `478 chars, sha256 936ca2dd7807: {"type":"error","error":{"type":"invalid_request_error","message":"claude (only …`. The rows below compare the request repeated with `x-proxy-lossy: 1`, which dropped `323 chars, sha256 4e8006dbd16e: anthropic-beta:per-turn-control-2026-07-01,anthropic-beta:mid-conversation-tool-…`.

23 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `accept` | `application/json` | `text/event-stream` |
| 2 | header-value | `user-agent` | `claude-cli/2.1.304 (external, sdk-cli)` | `claude-cli/2.1.280.b1a (external, sdk-cli)` |
| 3 | header-missing | `x-claude-code-session-id` | `<uuid>` | — |
| 4 | header-case | `x-stainless-arch` | `X-Stainless-Arch` | `x-stainless-arch` |
| 5 | header-case | `x-stainless-lang` | `X-Stainless-Lang` | `x-stainless-lang` |
| 6 | header-value | `x-stainless-os` | `Linux` | `Windows` |
| 7 | header-case | `x-stainless-os` | `X-Stainless-OS` | `x-stainless-os` |
| 8 | header-value | `x-stainless-package-version` | `0.128.0` | `0.112.1` |
| 9 | header-case | `x-stainless-package-version` | `X-Stainless-Package-Version` | `x-stainless-package-version` |
| 10 | header-case | `x-stainless-retry-count` | `X-Stainless-Retry-Count` | `x-stainless-retry-count` |
| 11 | header-case | `x-stainless-runtime` | `X-Stainless-Runtime` | `x-stainless-runtime` |
| 12 | header-case | `x-stainless-runtime-version` | `X-Stainless-Runtime-Version` | `x-stainless-runtime-version` |
| 13 | header-case | `x-stainless-timeout` | `X-Stainless-Timeout` | `x-stainless-timeout` |
| 14 | header-value | `anthropic-beta` | `492 chars, sha256 b04a02bc3b58: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` | `273 chars, sha256 82afd1eb713f: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` |
| 15 | header-missing | `anthropic-dispatch-id` | `v2d` | — |
| 16 | header-missing | `x-cc-atis` | `711efd76d10f17e5` | — |
| 17 | header-missing | `x-claude-code-prompt-id` | `<uuid>` | — |
| 18 | header-missing | `x-claude-code-request-class` | `main` | — |
| 19 | header-extra | `x-cc-session-id` | — | `<uuid>` |
| 20 | header-order | `headers` | `405 chars, sha256 526e1ef0d289: ["accept","authorization","content-type","user-agent","x-stainless-arch","x-stai…` | `405 chars, sha256 58f7f4f3dc2c: ["accept","authorization","content-type","user-agent","anthropic-beta","anthropi…` |
| 21 | body-length | `/system` | `4` | `6` |
| 22 | body-extra | `/system/+0` | — | `131 chars, sha256 aefc5e18cfda: {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.b1a; cc_en…` |
| 23 | body-extra | `/system/+1` | — | `{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."}` |

#### claude 2.1.304 (Claude Code) — capture `claude/2026-10-20-22-26-06/workflow` seq 34

Client request: `https://api.anthropic.com/v1/messages` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the captured headers in their order with the proxy token in `Authorization`, and the captured body with the model named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the HTTP stack.

**Refused as sent:** 400 `478 chars, sha256 936ca2dd7807: {"type":"error","error":{"type":"invalid_request_error","message":"claude (only …`. The rows below compare the request repeated with `x-proxy-lossy: 1`, which dropped `323 chars, sha256 4e8006dbd16e: anthropic-beta:per-turn-control-2026-07-01,anthropic-beta:mid-conversation-tool-…`.

23 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `accept` | `application/json` | `text/event-stream` |
| 2 | header-value | `user-agent` | `claude-cli/2.1.304 (external, sdk-cli)` | `claude-cli/2.1.280.b1a (external, sdk-cli)` |
| 3 | header-missing | `x-claude-code-session-id` | `<uuid>` | — |
| 4 | header-case | `x-stainless-arch` | `X-Stainless-Arch` | `x-stainless-arch` |
| 5 | header-case | `x-stainless-lang` | `X-Stainless-Lang` | `x-stainless-lang` |
| 6 | header-value | `x-stainless-os` | `Linux` | `Windows` |
| 7 | header-case | `x-stainless-os` | `X-Stainless-OS` | `x-stainless-os` |
| 8 | header-value | `x-stainless-package-version` | `0.128.0` | `0.112.1` |
| 9 | header-case | `x-stainless-package-version` | `X-Stainless-Package-Version` | `x-stainless-package-version` |
| 10 | header-case | `x-stainless-retry-count` | `X-Stainless-Retry-Count` | `x-stainless-retry-count` |
| 11 | header-case | `x-stainless-runtime` | `X-Stainless-Runtime` | `x-stainless-runtime` |
| 12 | header-case | `x-stainless-runtime-version` | `X-Stainless-Runtime-Version` | `x-stainless-runtime-version` |
| 13 | header-case | `x-stainless-timeout` | `X-Stainless-Timeout` | `x-stainless-timeout` |
| 14 | header-value | `anthropic-beta` | `492 chars, sha256 b04a02bc3b58: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` | `273 chars, sha256 82afd1eb713f: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` |
| 15 | header-missing | `anthropic-dispatch-id` | `v2d` | — |
| 16 | header-missing | `x-cc-atis` | `711efd76d10f17e5` | — |
| 17 | header-missing | `x-claude-code-prompt-id` | `<uuid>` | — |
| 18 | header-missing | `x-claude-code-request-class` | `main` | — |
| 19 | header-extra | `x-cc-session-id` | — | `<uuid>` |
| 20 | header-order | `headers` | `405 chars, sha256 526e1ef0d289: ["accept","authorization","content-type","user-agent","x-stainless-arch","x-stai…` | `405 chars, sha256 58f7f4f3dc2c: ["accept","authorization","content-type","user-agent","anthropic-beta","anthropi…` |
| 21 | body-length | `/system` | `4` | `6` |
| 22 | body-extra | `/system/+0` | — | `131 chars, sha256 aefc5e18cfda: {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.b1a; cc_en…` |
| 23 | body-extra | `/system/+1` | — | `{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."}` |

#### claude 2.1.304 (Claude Code) — capture `claude/2026-10-20-22-27-09/workflow` seq 15

Client request: `https://api.anthropic.com/v1/messages` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the captured headers in their order with the proxy token in `Authorization`, and the captured body with the model named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the HTTP stack.

**Refused as sent:** 400 `478 chars, sha256 936ca2dd7807: {"type":"error","error":{"type":"invalid_request_error","message":"claude (only …`. The rows below compare the request repeated with `x-proxy-lossy: 1`, which dropped `323 chars, sha256 4e8006dbd16e: anthropic-beta:per-turn-control-2026-07-01,anthropic-beta:mid-conversation-tool-…`.

23 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `accept` | `application/json` | `text/event-stream` |
| 2 | header-value | `user-agent` | `claude-cli/2.1.304 (external, sdk-cli)` | `claude-cli/2.1.280.b1a (external, sdk-cli)` |
| 3 | header-missing | `x-claude-code-session-id` | `<uuid>` | — |
| 4 | header-case | `x-stainless-arch` | `X-Stainless-Arch` | `x-stainless-arch` |
| 5 | header-case | `x-stainless-lang` | `X-Stainless-Lang` | `x-stainless-lang` |
| 6 | header-value | `x-stainless-os` | `Linux` | `Windows` |
| 7 | header-case | `x-stainless-os` | `X-Stainless-OS` | `x-stainless-os` |
| 8 | header-value | `x-stainless-package-version` | `0.128.0` | `0.112.1` |
| 9 | header-case | `x-stainless-package-version` | `X-Stainless-Package-Version` | `x-stainless-package-version` |
| 10 | header-case | `x-stainless-retry-count` | `X-Stainless-Retry-Count` | `x-stainless-retry-count` |
| 11 | header-case | `x-stainless-runtime` | `X-Stainless-Runtime` | `x-stainless-runtime` |
| 12 | header-case | `x-stainless-runtime-version` | `X-Stainless-Runtime-Version` | `x-stainless-runtime-version` |
| 13 | header-case | `x-stainless-timeout` | `X-Stainless-Timeout` | `x-stainless-timeout` |
| 14 | header-value | `anthropic-beta` | `492 chars, sha256 b04a02bc3b58: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` | `273 chars, sha256 82afd1eb713f: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` |
| 15 | header-missing | `anthropic-dispatch-id` | `v2d` | — |
| 16 | header-missing | `x-cc-atis` | `711efd76d10f17e5` | — |
| 17 | header-missing | `x-claude-code-prompt-id` | `<uuid>` | — |
| 18 | header-missing | `x-claude-code-request-class` | `main` | — |
| 19 | header-extra | `x-cc-session-id` | — | `<uuid>` |
| 20 | header-order | `headers` | `405 chars, sha256 526e1ef0d289: ["accept","authorization","content-type","user-agent","x-stainless-arch","x-stai…` | `405 chars, sha256 58f7f4f3dc2c: ["accept","authorization","content-type","user-agent","anthropic-beta","anthropi…` |
| 21 | body-length | `/system` | `4` | `6` |
| 22 | body-extra | `/system/+0` | — | `131 chars, sha256 aefc5e18cfda: {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.b1a; cc_en…` |
| 23 | body-extra | `/system/+1` | — | `{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."}` |

#### claude 2.1.304 (Claude Code) — capture `claude/2026-10-20-22-27-09/workflow` seq 16

Client request: `https://api.anthropic.com/v1/messages` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the captured headers in their order with the proxy token in `Authorization`, and the captured body with the model named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the HTTP stack.

**Refused as sent:** 400 `478 chars, sha256 936ca2dd7807: {"type":"error","error":{"type":"invalid_request_error","message":"claude (only …`. The rows below compare the request repeated with `x-proxy-lossy: 1`, which dropped `323 chars, sha256 4e8006dbd16e: anthropic-beta:per-turn-control-2026-07-01,anthropic-beta:mid-conversation-tool-…`.

24 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `accept` | `application/json` | `text/event-stream` |
| 2 | header-value | `user-agent` | `claude-cli/2.1.304 (external, sdk-cli)` | `claude-cli/2.1.280.b1a (external, sdk-cli)` |
| 3 | header-missing | `x-claude-code-session-id` | `<uuid>` | — |
| 4 | header-case | `x-stainless-arch` | `X-Stainless-Arch` | `x-stainless-arch` |
| 5 | header-case | `x-stainless-lang` | `X-Stainless-Lang` | `x-stainless-lang` |
| 6 | header-value | `x-stainless-os` | `Linux` | `Windows` |
| 7 | header-case | `x-stainless-os` | `X-Stainless-OS` | `x-stainless-os` |
| 8 | header-value | `x-stainless-package-version` | `0.128.0` | `0.112.1` |
| 9 | header-case | `x-stainless-package-version` | `X-Stainless-Package-Version` | `x-stainless-package-version` |
| 10 | header-case | `x-stainless-retry-count` | `X-Stainless-Retry-Count` | `x-stainless-retry-count` |
| 11 | header-case | `x-stainless-runtime` | `X-Stainless-Runtime` | `x-stainless-runtime` |
| 12 | header-case | `x-stainless-runtime-version` | `X-Stainless-Runtime-Version` | `x-stainless-runtime-version` |
| 13 | header-case | `x-stainless-timeout` | `X-Stainless-Timeout` | `x-stainless-timeout` |
| 14 | header-value | `anthropic-beta` | `492 chars, sha256 b04a02bc3b58: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` | `273 chars, sha256 82afd1eb713f: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-t…` |
| 15 | header-missing | `anthropic-dispatch-id` | `v2d` | — |
| 16 | header-missing | `x-cc-atis` | `711efd76d10f17e5` | — |
| 17 | header-missing | `x-claude-code-prev-tool-durations` | `Bash=83` | — |
| 18 | header-missing | `x-claude-code-prompt-id` | `<uuid>` | — |
| 19 | header-missing | `x-claude-code-request-class` | `main` | — |
| 20 | header-extra | `x-cc-session-id` | — | `<uuid>` |
| 21 | header-order | `headers` | `405 chars, sha256 526e1ef0d289: ["accept","authorization","content-type","user-agent","x-stainless-arch","x-stai…` | `405 chars, sha256 58f7f4f3dc2c: ["accept","authorization","content-type","user-agent","anthropic-beta","anthropi…` |
| 22 | body-length | `/system` | `1` | `3` |
| 23 | body-extra | `/system/+0` | — | `131 chars, sha256 aefc5e18cfda: {"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.b1a; cc_en…` |
| 24 | body-extra | `/system/+1` | — | `{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."}` |

#### antigravity 1.107.0 — capture `antigravity/2026-10-21-23-59-49/login` seq 3287

Client request: `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Antigravity speaks the Cloud Code envelope itself; a Gemini client of the proxy sends only the inner request. The input is the captured `request` without its envelope-only fields `sessionId` and `labels`, posted to `/gemini/v1beta/models/antigravity%2F<model>:streamGenerateContent?alt=sse` with the token in `x-goog-api-key`. Everything the proxy then adds — envelope, labels, session, headers — is compared with what Antigravity sent.

34 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `user-agent` | `antigravity/ide/2.5.5 (aidev_client; os_type=linux; arch=amd64)` | `antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)` |
| 2 | header-missing | `transfer-encoding` | `chunked` | — |
| 3 | header-extra | `connection` | — | `keep-alive` |
| 4 | header-extra | `accept` | — | `*/*` |
| 5 | header-extra | `content-length` | — | `<content-length>` |
| 6 | header-order | `headers` | `["host","user-agent","authorization","content-type","accept-encoding"]` | `["accept-encoding","authorization","content-type","user-agent","host"]` |
| 7 | body-length | `/request/tools` | `14` | `1` |
| 8 | body-length | `/request/tools/0/functionDeclarations` | `1` | `14` |
| 9 | body-extra | `/request/tools/0/functionDeclarations/+1` | — | `3803 chars, sha256 f589b05470d1: {"name":"browser_subagent","description":"Start a browser subagent to perform ac…` |
| 10 | body-extra | `/request/tools/0/functionDeclarations/+2` | — | `2002 chars, sha256 38246a71a5b0: {"name":"generate_image","description":"Generate an image or edit existing image…` |
| 11 | body-extra | `/request/tools/0/functionDeclarations/+3` | — | `2460 chars, sha256 a9bc41bc1183: {"name":"grep_search","description":"Use ripgrep to find exact pattern matches w…` |
| 12 | body-extra | `/request/tools/0/functionDeclarations/+4` | — | `1238 chars, sha256 d6b77f6e1789: {"name":"list_dir","description":"List the contents of a directory, i.e. all fil…` |
| 13 | body-extra | `/request/tools/0/functionDeclarations/+5` | — | `1585 chars, sha256 600480b63472: {"name":"manage_task","description":"Manage background tasks. Use this tool to l…` |
| 14 | body-extra | `/request/tools/0/functionDeclarations/+6` | — | `5729 chars, sha256 6632cbc46992: {"name":"multi_replace_file_content","description":"Use this tool to edit an exi…` |
| 15 | body-extra | `/request/tools/0/functionDeclarations/+7` | — | `1118 chars, sha256 d6cc82f894c7: {"name":"read_url_content","description":"Fetch content from a URL via HTTP requ…` |
| 16 | body-extra | `/request/tools/0/functionDeclarations/+8` | — | `4384 chars, sha256 24e1aad0bfcb: {"name":"replace_file_content","description":"Use this tool to edit an existing …` |
| 17 | body-extra | `/request/tools/0/functionDeclarations/+9` | — | `3793 chars, sha256 f8e12b332449: {"name":"run_command","description":"PROPOSE a command to run on behalf of the u…` |
| 18 | body-extra | `/request/tools/0/functionDeclarations/+10` | — | `7049 chars, sha256 a741e97f4d28: {"name":"schedule","description":"Schedule a one-shot timer or a recurring cron …` |
| 19 | body-extra | `/request/tools/0/functionDeclarations/+11` | — | `866 chars, sha256 3057395d3203: {"name":"search_web","description":"Performs a web search for a given query. Ret…` |
| 20 | body-extra | `/request/tools/0/functionDeclarations/+12` | — | `2526 chars, sha256 7a6a96232dd5: {"name":"view_file","description":"View the contents of a file from the local fi…` |
| 21 | body-extra | `/request/tools/0/functionDeclarations/+13` | — | `2619 chars, sha256 cf8bb0c2b91c: {"name":"write_to_file","description":"Use this tool to create new files. The fi…` |
| 22 | body-missing | `/request/tools/1` | `3830 chars, sha256 688eba802269: {"functionDeclarations":[{"name":"browser_subagent","description":"Start a brows…` | — |
| 23 | body-missing | `/request/tools/2` | `2029 chars, sha256 df8286237190: {"functionDeclarations":[{"name":"generate_image","description":"Generate an ima…` | — |
| 24 | body-missing | `/request/tools/3` | `2487 chars, sha256 d00afe330d60: {"functionDeclarations":[{"name":"grep_search","description":"Use ripgrep to fin…` | — |
| 25 | body-missing | `/request/tools/4` | `1265 chars, sha256 585fa926f204: {"functionDeclarations":[{"name":"list_dir","description":"List the contents of …` | — |
| 26 | body-missing | `/request/tools/5` | `1612 chars, sha256 3d3a2cba8beb: {"functionDeclarations":[{"name":"manage_task","description":"Manage background …` | — |
| 27 | body-missing | `/request/tools/6` | `5756 chars, sha256 68a0f7472e7f: {"functionDeclarations":[{"name":"multi_replace_file_content","description":"Use…` | — |
| 28 | body-missing | `/request/tools/7` | `1145 chars, sha256 81ba896a6735: {"functionDeclarations":[{"name":"read_url_content","description":"Fetch content…` | — |
| 29 | body-missing | `/request/tools/8` | `4411 chars, sha256 28b2ed4a5c0d: {"functionDeclarations":[{"name":"replace_file_content","description":"Use this …` | — |
| 30 | body-missing | `/request/tools/9` | `3820 chars, sha256 1b395d2392c8: {"functionDeclarations":[{"name":"run_command","description":"PROPOSE a command …` | — |
| 31 | body-missing | `/request/tools/10` | `7076 chars, sha256 97a187fb81dc: {"functionDeclarations":[{"name":"schedule","description":"Schedule a one-shot t…` | — |
| 32 | body-missing | `/request/tools/11` | `893 chars, sha256 cb10c0aa72e6: {"functionDeclarations":[{"name":"search_web","description":"Performs a web sear…` | — |
| 33 | body-missing | `/request/tools/12` | `2553 chars, sha256 48021d626d46: {"functionDeclarations":[{"name":"view_file","description":"View the contents of…` | — |
| 34 | body-missing | `/request/tools/13` | `2646 chars, sha256 588f7ddf8a6b: {"functionDeclarations":[{"name":"write_to_file","description":"Use this tool to…` | — |

#### antigravity 1.107.0 — capture `antigravity/2026-10-21-23-59-49/login` seq 3306

Client request: `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Antigravity speaks the Cloud Code envelope itself; a Gemini client of the proxy sends only the inner request. The input is the captured `request` without its envelope-only fields `sessionId` and `labels`, posted to `/gemini/v1beta/models/antigravity%2F<model>:streamGenerateContent?alt=sse` with the token in `x-goog-api-key`. Everything the proxy then adds — envelope, labels, session, headers — is compared with what Antigravity sent.

34 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `user-agent` | `antigravity/ide/2.5.5 (aidev_client; os_type=linux; arch=amd64)` | `antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)` |
| 2 | header-missing | `transfer-encoding` | `chunked` | — |
| 3 | header-extra | `connection` | — | `keep-alive` |
| 4 | header-extra | `accept` | — | `*/*` |
| 5 | header-extra | `content-length` | — | `<content-length>` |
| 6 | header-order | `headers` | `["host","user-agent","authorization","content-type","accept-encoding"]` | `["accept-encoding","authorization","content-type","user-agent","host"]` |
| 7 | body-length | `/request/tools` | `14` | `1` |
| 8 | body-length | `/request/tools/0/functionDeclarations` | `1` | `14` |
| 9 | body-extra | `/request/tools/0/functionDeclarations/+1` | — | `3803 chars, sha256 f589b05470d1: {"name":"browser_subagent","description":"Start a browser subagent to perform ac…` |
| 10 | body-extra | `/request/tools/0/functionDeclarations/+2` | — | `2002 chars, sha256 38246a71a5b0: {"name":"generate_image","description":"Generate an image or edit existing image…` |
| 11 | body-extra | `/request/tools/0/functionDeclarations/+3` | — | `2460 chars, sha256 a9bc41bc1183: {"name":"grep_search","description":"Use ripgrep to find exact pattern matches w…` |
| 12 | body-extra | `/request/tools/0/functionDeclarations/+4` | — | `1238 chars, sha256 d6b77f6e1789: {"name":"list_dir","description":"List the contents of a directory, i.e. all fil…` |
| 13 | body-extra | `/request/tools/0/functionDeclarations/+5` | — | `1585 chars, sha256 600480b63472: {"name":"manage_task","description":"Manage background tasks. Use this tool to l…` |
| 14 | body-extra | `/request/tools/0/functionDeclarations/+6` | — | `5729 chars, sha256 6632cbc46992: {"name":"multi_replace_file_content","description":"Use this tool to edit an exi…` |
| 15 | body-extra | `/request/tools/0/functionDeclarations/+7` | — | `1118 chars, sha256 d6cc82f894c7: {"name":"read_url_content","description":"Fetch content from a URL via HTTP requ…` |
| 16 | body-extra | `/request/tools/0/functionDeclarations/+8` | — | `4384 chars, sha256 24e1aad0bfcb: {"name":"replace_file_content","description":"Use this tool to edit an existing …` |
| 17 | body-extra | `/request/tools/0/functionDeclarations/+9` | — | `3793 chars, sha256 f8e12b332449: {"name":"run_command","description":"PROPOSE a command to run on behalf of the u…` |
| 18 | body-extra | `/request/tools/0/functionDeclarations/+10` | — | `7049 chars, sha256 a741e97f4d28: {"name":"schedule","description":"Schedule a one-shot timer or a recurring cron …` |
| 19 | body-extra | `/request/tools/0/functionDeclarations/+11` | — | `866 chars, sha256 3057395d3203: {"name":"search_web","description":"Performs a web search for a given query. Ret…` |
| 20 | body-extra | `/request/tools/0/functionDeclarations/+12` | — | `2526 chars, sha256 7a6a96232dd5: {"name":"view_file","description":"View the contents of a file from the local fi…` |
| 21 | body-extra | `/request/tools/0/functionDeclarations/+13` | — | `2619 chars, sha256 cf8bb0c2b91c: {"name":"write_to_file","description":"Use this tool to create new files. The fi…` |
| 22 | body-missing | `/request/tools/1` | `3830 chars, sha256 688eba802269: {"functionDeclarations":[{"name":"browser_subagent","description":"Start a brows…` | — |
| 23 | body-missing | `/request/tools/2` | `2029 chars, sha256 df8286237190: {"functionDeclarations":[{"name":"generate_image","description":"Generate an ima…` | — |
| 24 | body-missing | `/request/tools/3` | `2487 chars, sha256 d00afe330d60: {"functionDeclarations":[{"name":"grep_search","description":"Use ripgrep to fin…` | — |
| 25 | body-missing | `/request/tools/4` | `1265 chars, sha256 585fa926f204: {"functionDeclarations":[{"name":"list_dir","description":"List the contents of …` | — |
| 26 | body-missing | `/request/tools/5` | `1612 chars, sha256 3d3a2cba8beb: {"functionDeclarations":[{"name":"manage_task","description":"Manage background …` | — |
| 27 | body-missing | `/request/tools/6` | `5756 chars, sha256 68a0f7472e7f: {"functionDeclarations":[{"name":"multi_replace_file_content","description":"Use…` | — |
| 28 | body-missing | `/request/tools/7` | `1145 chars, sha256 81ba896a6735: {"functionDeclarations":[{"name":"read_url_content","description":"Fetch content…` | — |
| 29 | body-missing | `/request/tools/8` | `4411 chars, sha256 28b2ed4a5c0d: {"functionDeclarations":[{"name":"replace_file_content","description":"Use this …` | — |
| 30 | body-missing | `/request/tools/9` | `3820 chars, sha256 1b395d2392c8: {"functionDeclarations":[{"name":"run_command","description":"PROPOSE a command …` | — |
| 31 | body-missing | `/request/tools/10` | `7076 chars, sha256 97a187fb81dc: {"functionDeclarations":[{"name":"schedule","description":"Schedule a one-shot t…` | — |
| 32 | body-missing | `/request/tools/11` | `893 chars, sha256 cb10c0aa72e6: {"functionDeclarations":[{"name":"search_web","description":"Performs a web sear…` | — |
| 33 | body-missing | `/request/tools/12` | `2553 chars, sha256 48021d626d46: {"functionDeclarations":[{"name":"view_file","description":"View the contents of…` | — |
| 34 | body-missing | `/request/tools/13` | `2646 chars, sha256 588f7ddf8a6b: {"functionDeclarations":[{"name":"write_to_file","description":"Use this tool to…` | — |

#### antigravity 1.107.0 — capture `antigravity/2026-10-21-23-59-49/login` seq 3313

Client request: `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Antigravity speaks the Cloud Code envelope itself; a Gemini client of the proxy sends only the inner request. The input is the captured `request` without its envelope-only fields `sessionId` and `labels`, posted to `/gemini/v1beta/models/antigravity%2F<model>:streamGenerateContent?alt=sse` with the token in `x-goog-api-key`. Everything the proxy then adds — envelope, labels, session, headers — is compared with what Antigravity sent.

34 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `user-agent` | `antigravity/ide/2.5.5 (aidev_client; os_type=linux; arch=amd64)` | `antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)` |
| 2 | header-missing | `transfer-encoding` | `chunked` | — |
| 3 | header-extra | `connection` | — | `keep-alive` |
| 4 | header-extra | `accept` | — | `*/*` |
| 5 | header-extra | `content-length` | — | `<content-length>` |
| 6 | header-order | `headers` | `["host","user-agent","authorization","content-type","accept-encoding"]` | `["accept-encoding","authorization","content-type","user-agent","host"]` |
| 7 | body-length | `/request/tools` | `14` | `1` |
| 8 | body-length | `/request/tools/0/functionDeclarations` | `1` | `14` |
| 9 | body-extra | `/request/tools/0/functionDeclarations/+1` | — | `3803 chars, sha256 f589b05470d1: {"name":"browser_subagent","description":"Start a browser subagent to perform ac…` |
| 10 | body-extra | `/request/tools/0/functionDeclarations/+2` | — | `2002 chars, sha256 38246a71a5b0: {"name":"generate_image","description":"Generate an image or edit existing image…` |
| 11 | body-extra | `/request/tools/0/functionDeclarations/+3` | — | `2460 chars, sha256 a9bc41bc1183: {"name":"grep_search","description":"Use ripgrep to find exact pattern matches w…` |
| 12 | body-extra | `/request/tools/0/functionDeclarations/+4` | — | `1238 chars, sha256 d6b77f6e1789: {"name":"list_dir","description":"List the contents of a directory, i.e. all fil…` |
| 13 | body-extra | `/request/tools/0/functionDeclarations/+5` | — | `1585 chars, sha256 600480b63472: {"name":"manage_task","description":"Manage background tasks. Use this tool to l…` |
| 14 | body-extra | `/request/tools/0/functionDeclarations/+6` | — | `5729 chars, sha256 6632cbc46992: {"name":"multi_replace_file_content","description":"Use this tool to edit an exi…` |
| 15 | body-extra | `/request/tools/0/functionDeclarations/+7` | — | `1118 chars, sha256 d6cc82f894c7: {"name":"read_url_content","description":"Fetch content from a URL via HTTP requ…` |
| 16 | body-extra | `/request/tools/0/functionDeclarations/+8` | — | `4384 chars, sha256 24e1aad0bfcb: {"name":"replace_file_content","description":"Use this tool to edit an existing …` |
| 17 | body-extra | `/request/tools/0/functionDeclarations/+9` | — | `3793 chars, sha256 f8e12b332449: {"name":"run_command","description":"PROPOSE a command to run on behalf of the u…` |
| 18 | body-extra | `/request/tools/0/functionDeclarations/+10` | — | `7049 chars, sha256 a741e97f4d28: {"name":"schedule","description":"Schedule a one-shot timer or a recurring cron …` |
| 19 | body-extra | `/request/tools/0/functionDeclarations/+11` | — | `866 chars, sha256 3057395d3203: {"name":"search_web","description":"Performs a web search for a given query. Ret…` |
| 20 | body-extra | `/request/tools/0/functionDeclarations/+12` | — | `2526 chars, sha256 7a6a96232dd5: {"name":"view_file","description":"View the contents of a file from the local fi…` |
| 21 | body-extra | `/request/tools/0/functionDeclarations/+13` | — | `2619 chars, sha256 cf8bb0c2b91c: {"name":"write_to_file","description":"Use this tool to create new files. The fi…` |
| 22 | body-missing | `/request/tools/1` | `3830 chars, sha256 688eba802269: {"functionDeclarations":[{"name":"browser_subagent","description":"Start a brows…` | — |
| 23 | body-missing | `/request/tools/2` | `2029 chars, sha256 df8286237190: {"functionDeclarations":[{"name":"generate_image","description":"Generate an ima…` | — |
| 24 | body-missing | `/request/tools/3` | `2487 chars, sha256 d00afe330d60: {"functionDeclarations":[{"name":"grep_search","description":"Use ripgrep to fin…` | — |
| 25 | body-missing | `/request/tools/4` | `1265 chars, sha256 585fa926f204: {"functionDeclarations":[{"name":"list_dir","description":"List the contents of …` | — |
| 26 | body-missing | `/request/tools/5` | `1612 chars, sha256 3d3a2cba8beb: {"functionDeclarations":[{"name":"manage_task","description":"Manage background …` | — |
| 27 | body-missing | `/request/tools/6` | `5756 chars, sha256 68a0f7472e7f: {"functionDeclarations":[{"name":"multi_replace_file_content","description":"Use…` | — |
| 28 | body-missing | `/request/tools/7` | `1145 chars, sha256 81ba896a6735: {"functionDeclarations":[{"name":"read_url_content","description":"Fetch content…` | — |
| 29 | body-missing | `/request/tools/8` | `4411 chars, sha256 28b2ed4a5c0d: {"functionDeclarations":[{"name":"replace_file_content","description":"Use this …` | — |
| 30 | body-missing | `/request/tools/9` | `3820 chars, sha256 1b395d2392c8: {"functionDeclarations":[{"name":"run_command","description":"PROPOSE a command …` | — |
| 31 | body-missing | `/request/tools/10` | `7076 chars, sha256 97a187fb81dc: {"functionDeclarations":[{"name":"schedule","description":"Schedule a one-shot t…` | — |
| 32 | body-missing | `/request/tools/11` | `893 chars, sha256 cb10c0aa72e6: {"functionDeclarations":[{"name":"search_web","description":"Performs a web sear…` | — |
| 33 | body-missing | `/request/tools/12` | `2553 chars, sha256 48021d626d46: {"functionDeclarations":[{"name":"view_file","description":"View the contents of…` | — |
| 34 | body-missing | `/request/tools/13` | `2646 chars, sha256 588f7ddf8a6b: {"functionDeclarations":[{"name":"write_to_file","description":"Use this tool to…` | — |

#### antigravity 1.107.0 — capture `antigravity/2026-10-21-23-59-49/login` seq 3343

Client request: `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` (HTTP/1.1). Proxy answer to the client: 200; proxy upstream requests on that path: 1 (HTTP/1.1 to the loopback tap).

Antigravity speaks the Cloud Code envelope itself; a Gemini client of the proxy sends only the inner request. The input is the captured `request` without its envelope-only fields `sessionId` and `labels`, posted to `/gemini/v1beta/models/antigravity%2F<model>:streamGenerateContent?alt=sse` with the token in `x-goog-api-key`. Everything the proxy then adds — envelope, labels, session, headers — is compared with what Antigravity sent.

34 difference(s).

| # | Kind | Where | Client (plane A) | Proxy (plane B) |
|---|---|---|---|---|
| 1 | header-value | `user-agent` | `antigravity/ide/2.5.5 (aidev_client; os_type=linux; arch=amd64)` | `antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)` |
| 2 | header-missing | `transfer-encoding` | `chunked` | — |
| 3 | header-extra | `connection` | — | `keep-alive` |
| 4 | header-extra | `accept` | — | `*/*` |
| 5 | header-extra | `content-length` | — | `<content-length>` |
| 6 | header-order | `headers` | `["host","user-agent","authorization","content-type","accept-encoding"]` | `["accept-encoding","authorization","content-type","user-agent","host"]` |
| 7 | body-length | `/request/tools` | `14` | `1` |
| 8 | body-length | `/request/tools/0/functionDeclarations` | `1` | `14` |
| 9 | body-extra | `/request/tools/0/functionDeclarations/+1` | — | `3803 chars, sha256 f589b05470d1: {"name":"browser_subagent","description":"Start a browser subagent to perform ac…` |
| 10 | body-extra | `/request/tools/0/functionDeclarations/+2` | — | `2002 chars, sha256 38246a71a5b0: {"name":"generate_image","description":"Generate an image or edit existing image…` |
| 11 | body-extra | `/request/tools/0/functionDeclarations/+3` | — | `2460 chars, sha256 a9bc41bc1183: {"name":"grep_search","description":"Use ripgrep to find exact pattern matches w…` |
| 12 | body-extra | `/request/tools/0/functionDeclarations/+4` | — | `1238 chars, sha256 d6b77f6e1789: {"name":"list_dir","description":"List the contents of a directory, i.e. all fil…` |
| 13 | body-extra | `/request/tools/0/functionDeclarations/+5` | — | `1585 chars, sha256 600480b63472: {"name":"manage_task","description":"Manage background tasks. Use this tool to l…` |
| 14 | body-extra | `/request/tools/0/functionDeclarations/+6` | — | `5729 chars, sha256 6632cbc46992: {"name":"multi_replace_file_content","description":"Use this tool to edit an exi…` |
| 15 | body-extra | `/request/tools/0/functionDeclarations/+7` | — | `1118 chars, sha256 d6cc82f894c7: {"name":"read_url_content","description":"Fetch content from a URL via HTTP requ…` |
| 16 | body-extra | `/request/tools/0/functionDeclarations/+8` | — | `4384 chars, sha256 24e1aad0bfcb: {"name":"replace_file_content","description":"Use this tool to edit an existing …` |
| 17 | body-extra | `/request/tools/0/functionDeclarations/+9` | — | `3793 chars, sha256 f8e12b332449: {"name":"run_command","description":"PROPOSE a command to run on behalf of the u…` |
| 18 | body-extra | `/request/tools/0/functionDeclarations/+10` | — | `7049 chars, sha256 a741e97f4d28: {"name":"schedule","description":"Schedule a one-shot timer or a recurring cron …` |
| 19 | body-extra | `/request/tools/0/functionDeclarations/+11` | — | `866 chars, sha256 3057395d3203: {"name":"search_web","description":"Performs a web search for a given query. Ret…` |
| 20 | body-extra | `/request/tools/0/functionDeclarations/+12` | — | `2526 chars, sha256 7a6a96232dd5: {"name":"view_file","description":"View the contents of a file from the local fi…` |
| 21 | body-extra | `/request/tools/0/functionDeclarations/+13` | — | `2619 chars, sha256 cf8bb0c2b91c: {"name":"write_to_file","description":"Use this tool to create new files. The fi…` |
| 22 | body-missing | `/request/tools/1` | `3830 chars, sha256 688eba802269: {"functionDeclarations":[{"name":"browser_subagent","description":"Start a brows…` | — |
| 23 | body-missing | `/request/tools/2` | `2029 chars, sha256 df8286237190: {"functionDeclarations":[{"name":"generate_image","description":"Generate an ima…` | — |
| 24 | body-missing | `/request/tools/3` | `2487 chars, sha256 d00afe330d60: {"functionDeclarations":[{"name":"grep_search","description":"Use ripgrep to fin…` | — |
| 25 | body-missing | `/request/tools/4` | `1265 chars, sha256 585fa926f204: {"functionDeclarations":[{"name":"list_dir","description":"List the contents of …` | — |
| 26 | body-missing | `/request/tools/5` | `1612 chars, sha256 3d3a2cba8beb: {"functionDeclarations":[{"name":"manage_task","description":"Manage background …` | — |
| 27 | body-missing | `/request/tools/6` | `5756 chars, sha256 68a0f7472e7f: {"functionDeclarations":[{"name":"multi_replace_file_content","description":"Use…` | — |
| 28 | body-missing | `/request/tools/7` | `1145 chars, sha256 81ba896a6735: {"functionDeclarations":[{"name":"read_url_content","description":"Fetch content…` | — |
| 29 | body-missing | `/request/tools/8` | `4411 chars, sha256 28b2ed4a5c0d: {"functionDeclarations":[{"name":"replace_file_content","description":"Use this …` | — |
| 30 | body-missing | `/request/tools/9` | `3820 chars, sha256 1b395d2392c8: {"functionDeclarations":[{"name":"run_command","description":"PROPOSE a command …` | — |
| 31 | body-missing | `/request/tools/10` | `7076 chars, sha256 97a187fb81dc: {"functionDeclarations":[{"name":"schedule","description":"Schedule a one-shot t…` | — |
| 32 | body-missing | `/request/tools/11` | `893 chars, sha256 cb10c0aa72e6: {"functionDeclarations":[{"name":"search_web","description":"Performs a web sear…` | — |
| 33 | body-missing | `/request/tools/12` | `2553 chars, sha256 48021d626d46: {"functionDeclarations":[{"name":"view_file","description":"View the contents of…` | — |
| 34 | body-missing | `/request/tools/13` | `2646 chars, sha256 588f7ddf8a6b: {"functionDeclarations":[{"name":"write_to_file","description":"Use this tool to…` | — |
