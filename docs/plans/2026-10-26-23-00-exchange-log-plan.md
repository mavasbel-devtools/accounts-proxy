# Exchange log and account removal (plan 2026-10-26)

Extends [plan v4](2026-10-11-22-11-completion-plan.md) and the
[model-list refresh plan](2026-10-26-08-06-model-list-refresh-plan.md); nothing in them is replaced.

## Request

User, 2026-10-26: "Logs, all requests and responses must be logged", then: "can we log all full request (payload and
headers) and response (payload and headers) and times and tokens used (input, output, cache input, cache output, etc.)
and absolutely everything?" — and, approving the recommended set, `account remove` and the deletion of the leftover
`logs/router.log` (a former name, [AGENTS.md](../../AGENTS.md) §7 "Name").

## Measured starting state (commit 6228e11)

| Item | State |
|---|---|
| `logs/proxy.log` (`FileLogger`, `apps/proxy/src/adapters/outbound/system.ts`) | one line per call (`claude: /v1/messages model=… -> HTTP 200`), stream ends, renewals, errors; no headers, bodies, timings or token counts |
| `logs/router.log` | last written 2026-10-16, under the former name |
| Accounts | per provider `accounts-<provider>.json` = `{ accounts, activeId }`; `account list`, `account use`; no removal |

## Decisions

| Id | Decision |
|---|---|
| X1 | Every HTTP exchange is recorded, as JSON lines in `logs/exchanges-YYYY-MM-DD.jsonl` (UTC date, file 0600, directory 0700): the client's request to the daemon (`client-request`) and the daemon's answer (`client-response`); every request the proxy sends upstream (`upstream-request`) and its answer (`upstream-response`) — model calls, token renewals, logins, model lists, quota, the reference catalog — from the daemon and from every command; the login's loopback callback (`login-callback`) and the browser page it opens (`browser-open`). |
| X2 | A record carries the method, the URL or path and query, every header (the client's in the order and case it sent them), the whole body, each response chunk with its arrival time and size (text, or base64 for a binary type), the status, and the timings (start; body read; response headers; first byte; end). The request record is written before the call, the response record when the body ends, so a call that hangs or crashes is still recorded. Upstream records name their client exchange (`exchange`), so one model call shows the client side and every upstream call it made. |
| X3 | Token usage is read from the answer's own fields in every format (Anthropic Messages `usage`, OpenAI Chat and Responses `usage`, Gemini and Antigravity `usageMetadata`), streamed or not, merged in arrival order: `usage.raw` holds every field verbatim, `usage.tokens` the normalized counts `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite5m`, `cacheWrite1h`, `reasoning`, `toolUsePrompt`, `total` (a count the answer does not state is absent, never computed). |
| X4 | Credential values never reach the file: the headers `authorization`, `proxy-authorization`, `x-api-key`, `x-goog-api-key`, `cookie`, `set-cookie`; the top-level body and query fields `access_token`, `refresh_token`, `id_token`, `code`, `code_verifier`, `client_secret`, `device_code`, `key`, `api_key`, `token`, `password`; and any string with a known token prefix (the recon manifest's list). Each is replaced by `[redacted sha256:<12 hex> len:<n>]`, so two records using the same credential show the same fingerprint. Everything else — prompts, answers, account e-mails and ids — is kept. Redaction runs in the one writer (`FileExchangeSink`) before the line is written. |
| X5 | `proxy.yaml` `exchangeLog: { enabled: true, retentionDays: 14 }` (defaults; validated strictly). A day file older than `retentionDays` (today included) is deleted at the first write of each day. No size cap. |
| X6 | Logging is best-effort: a write failure never fails a request or a login (as `FileLogger`). |
| A1 | `account remove <provider> <account-id>` deletes a stored account; when it was the active one, no account is active afterwards (the proxy never picks another by itself) and requests answer 401 `provider_auth_required` until `account use` or `login`. |
| A2 | `logs/router.log` is deleted. |

## Architecture

| Layer | Element |
|---|---|
| domain (`packages/core/src/domain/exchange-log.ts`) | record types, `BodyRecorder` (chunks, timing, text/base64), `tokenUsage`, `redactRecord` |
| ports/outbound (`packages/core/src/ports/outbound/exchange-log.ts`) | `ExchangeSinkPort` (write a record), `ExchangeScopePort` (the client exchange the current work belongs to) |
| ports/inbound (`packages/core/src/ports/inbound/exchange-log.ts`) | `ClientExchangePort` / `ClientExchangeTrace` |
| application | `ClientExchangeService` |
| adapters/inbound | `LoggingHttpHandler` (decorates `HttpHandler`) |
| adapters/outbound | `LoggingTransport` (decorates `HttpTransportPort`), `FileExchangeSink`, `AsyncExchangeScope` (`node:async_hooks`), `LoggingCallbackServerFactory`, `LoggingBrowserLauncher` |
| composition | wires the decorators when `exchangeLog.enabled` |

## Verification

`bun run verify` (100% coverage in every tier); a live check on an isolated daemon (own `ACCOUNTS_PROXY_HOME`) with a
real request through each signed-in provider family, the file inspected for every field of X2–X4 and for the absence
of every stored credential value; then the user's daemon restarted. Recorded below.

## Execution record

| Step | Result |
|---|---|
| Code (2026-10-27) | Domain `packages/core/src/domain/exchange-log.ts`; ports `packages/core/src/ports/{inbound,outbound}/exchange-log.ts` and `ContentDecoderPort` (`packages/core/src/ports/outbound/transport.ts`); `ClientExchangeService`; `LoggingHttpHandler`; `LoggingTransport`, `FileExchangeSink` (`exchange-log-file.ts`), `LoggingCallbackServerFactory` / `LoggingBrowserLauncher` (`logging-login.ts`), `ZstdContentDecoder`; wired in `container.ts` only when `exchangeLog.enabled`. `account remove` (A1) in `account-command.ts` / `account-services.ts`. |
| Refinements made while closing e2e coverage (2026-10-27) | X2: the text of a zstd request body the proxy compressed is the record's `decodedBody` (redacted like a body), not a field of `body`. X3: a later usage object restates the earlier keys, so it replaces them key by key (Anthropic's `message_delta`, Gemini's last chunk). A `login-callback` is written when the login answers the browser; a callback the login never answered is not written (the sign-in already failed in the terminal). A route that throws is not recorded separately: `RouteHandler` answers every error itself. |
| `bun run verify` (2026-10-27 19:10) | GATE: PASS — typecheck; 951 unit+component+arch tests, 100% lines/statements/functions/branches; build; 262 e2e tests, e2e 100%; merged 100%; docs lint 61 files. |
| Live check, isolated daemon (2026-10-27 19:14, own `ACCOUNTS_PROXY_HOME`, port 4199; copies of the non-rotating antigravity, openrouter, cheaper-inference accounts) | 24 records (5 client-request, 5 client-response, 7 upstream-request, 7 upstream-response) in `logs/exchanges-2026-10-28.jsonl` (UTC day), mode 0600. Usage `tokens` from Antigravity SSE `usageMetadata` (`input 3, output 1, reasoning 58, total 62`; no cache count stated, none written), Cheaper Inference Chat and OpenRouter Chat streamed. Every `authorization` / `x-goog-api-key` header written as `[redacted sha256:… len:…]`; 0 of the 6 stored credential values (accounts and proxy token) occur in the file; the real account files' SHA-256 unchanged; the isolated home removed afterwards. |
| A2 (2026-10-27 19:15) | `~/.local/share/accounts-proxy/logs/router.log` deleted; `logs/` holds `proxy.log` only. |
| User's daemon | Not restarted by the agent: port 4141 is held by `bun apps/proxy/src/main/cli.ts serve` (pid 932996), started 2026-10-26 21:47 from a GNOME Terminal, so the systemd unit `accounts-proxy.service` fails with `EADDRINUSE` and restarts every 3 s (counter 13096 at 19:14). The new code goes live when that terminal daemon is stopped and the unit takes the port. |
