# Daemon console output (plan 2026-10-27 C1)

Extends [the exchange-log plan](2026-10-26-23-00-exchange-log-plan.md); it changes no earlier decision.

## Request and decision

The user asked that `bun run proxy serve` print its log to the console. Asked how much to print, he chose
**Everything** (2026-10-27): every log line and every exchange record.

## C1 — what `serve` prints

| Item | Rule |
|---|---|
| When | From the moment the daemon listens (after the two start lines) until it stops. Commands other than `serve` print nothing extra, so their output stays what scripts read. |
| Log lines | Every line written to `<data>/logs/proxy.log`, in the same form (`<ISO time> <LEVEL> <message>`, errors with their stack). |
| Exchange records | Every record written to `<data>/logs/exchanges-YYYY-MM-DD.jsonl`, the same JSON line (schema `accounts-proxy-exchange/1`), with credentials replaced exactly as in the file (X4). None while `exchangeLog.enabled: false`. |
| Files | Still written; the console is a copy. |
| Failures | A failing console write is ignored, like a failing file write (X6). |

## Design

- Ports: `DaemonConsolePort` (inbound, `attach()`), `ConsoleMirrorPort` (outbound, `start()`, `line()`).
- Application: `DaemonConsoleService` starts the mirror; `ServeCommand` calls it once it listens.
- Adapters: `TerminalMirror` (stdout, silent until started), `MirroredLogger` and `MirroredExchangeSink` wrap the
  file logger and file sink; the line format is shared with the files (`logLine`, `exchangeLine`).

## Execution record

| Check | Result |
|---|---|
| `bun run verify` | GATE: PASS — 955 unit/component/arch, 262 e2e, 100% lines/statements/functions/branches in every tier, docs lint PASS |
| Tests | `apps/proxy/tests/unit/console-mirror.test.ts` (new); `cli-commands.test.ts` (attach only on `serve`, not on `serve --help`); e2e `daemon.test.ts` (all four record kinds on stdout, proxy token absent) |
| Live, isolated daemon (`ACCOUNTS_PROXY_HOME` in `/tmp/opencode`, port 4199) | start lines, then the `client-request` and `client-response` records of a request, then the stop lines; the token appears 0 times; the real account files and `token.json` unchanged (SHA-256 before = after); the user's daemon on 4141 not touched |
