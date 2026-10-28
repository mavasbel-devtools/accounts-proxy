# Plan 2026-10-27-23-29 — every write under a lock; usage and daemon logs in `.cache/logs` (winston)

Extends [plan 2026-10-26-23-00](2026-10-26-23-00-exchange-log-plan.md) (exchange log X1–X6),
[plan 2026-10-26-23-32](2026-10-26-23-32-accounts-file-plan.md) (accounts file A1–A4) and
[plan 2026-10-27-21-00](2026-10-27-21-00-daemon-console-plan.md) (console C1). Nothing earlier is rewritten; the
superseded parts are named in §3.

## 1. User decisions (2026-10-27)

| # | Question | Decision |
|---|---|---|
| U1 | Where requests are logged | `.cache/logs/<timestamp>-usage.jsonl`, not the terminal |
| U2 | Rotation | a new file every UTC day and past a size cap (`maxFileMegabytes`, default 100) |
| U3 | Retention | configurable, default 15 days |
| U4 | Terminal of `serve` | the daemon's log lines only, never the request records |
| U5 | `proxy.log` | moves to `.cache/logs` with the same rotation and retention |
| U6 | Existing files in `~/.local/share/accounts-proxy/logs/` | moved into `.cache/logs` |
| U7 | Library | winston 3.19.0 + winston-daily-rotate-file 5.0.0 |
| U8 | Locks | every write takes a lock file; for the logs: winston, one writer per process (each process its own files) |

## 2. Rules

- **L1 Folder.** The logs live in `<dir of the accounts file>/logs/` (default `<repo>/.cache/logs/`, 0700), next to
  `locks/`. A test that sets `ACCOUNTS_PROXY_ACCOUNTS_FILE` therefore also gets its own logs folder; no new variable.
- **L2 Files.** Each process writes only its own files (U8): `<UTC day>-<pid>-usage.jsonl` (one JSON line per record,
  credentials replaced first, as X4) and `<UTC day>-<pid>-proxy.log`. winston-daily-rotate-file opens a new file at
  the UTC day change and past `maxFileMegabytes`; the second file of a day is `<day>-<pid>-usage.1.jsonl`, then `.2`
  (measured 2026-10-27 with the pinned versions). Files are 0600. A process creates its files at its first line, so a
  command that logs nothing creates none.
- **L3 Retention.** Every deletion is the proxy's own sweep under the `logs` lock, so deletion is locked too (W1):
  at every new file (winston's `new` event, also at the first line), every log file of the
  L2 form whose UTC day is older than `retentionDays` (today included) is removed, whichever process wrote it. Other
  names are never touched. A process that writes no line neither sweeps nor creates `logs/` or `locks/` (an e2e
  `help` run with the default accounts file left both, empty, in the repository's `.cache/` until this rule;
  measured 2026-10-27). winston's own deletion (`maxFiles`) is not used; without it file-stream-rotator 0.6.1
  writes no audit file (measured 2026-10-27).
- **L3b Former files.** The move-in (U6) keeps `exchanges-<day>.jsonl` as named and renames `proxy.log` to
  `proxy-<UTC day of its last line>.log`; the sweep removes both forms by the day they state, like L2 files.
- **L3a Flush (measured 2026-10-27).** A size rotation ends the previous file stream, which flushes on its own;
  waiting only for the current stream at close lost the last lines of the files rotated just before (2029 of 3000
  lines on disk at close). `close` therefore waits until every file stream the process opened has closed.
- **L4 Configuration.** `proxy.yaml`:
  ```yaml
  logs:
    usage: true           # the request records; the daemon log is always written
    retentionDays: 15
    maxFileMegabytes: 100
  ```
  The former key `exchangeLog` is refused with a message naming `logs`.
- **L5 Terminal.** `serve` prints the daemon's log lines; the request records go only to the usage files.
- **L6 Shutdown.** Every process ends its log streams before it exits (`serve` after the server stopped), so the last
  record is on disk and nothing keeps the process alive.
- **W1 Locked writes.** Every file the proxy writes takes a lock in `<dir of the accounts file>/locks/`:
  the accounts file (`accounts`, unchanged), each state file (`state`), the proxy token (`token`) and the log sweep
  (`logs`). The token is created read-check-write under its lock, so two processes starting at once agree on one.
  The log appends themselves are not locked: no file has two writers (U8).

## 3. Superseded

- X1 path (`<home>/logs/exchanges-YYYY-MM-DD.jsonl`) and its own pruning → L1–L3.
- `exchangeLog: { enabled, retentionDays: 14 }` → L4.
- C1's printing of the exchange records → L5 (the log lines stay on the terminal).
- `<home>/logs/proxy.log` → L2.

## 4. Steps

1. Fix the open e2e failures of the last `verify`.
2. W1, L1–L6 with unit, component and e2e tests; docs (AGENTS.md, README, API reference, diagram) in step.
3. `bun run verify` green at 100%.
4. The user stops the daemon; the move-in moves the accounts and the old log files under the `accounts` and `logs`
   locks; `bun run proxy serve` again; one request per provider.
5. Commit and push.

## 5. Record

- **Step 1 (2026-10-28).** The e2e failures of the last run had three causes, each fixed at the source: two
  coverage gaps in the new code (the token store's "another process stored a token while this one waited" branch, the
  log stream's close when every file is already closed, the retention sweep's lock-timeout path), now reached by e2e
  tests (`cli.test.ts` token lock, `proxy-edges.test.ts` maxFileMegabytes rotation, `model-catalog.test.ts` held
  `logs` lock); 19 assertions that read the proxy log right after an answer, which can precede the winston line
  (L3a), now wait for it (`loggedEventually`, 5 s at most); and two waits sized for an idle host (the
  `--from-opencode` test, ~31 s alone, measured past its 60 s timeout under the 4x-parallel run at load average
  ~30; the paste-code prompt wait of 5 s), raised to 180 s and 30 s.
- **Step 2.** W1 and L1–L6 in `apps/proxy/src/adapters/outbound/{log-files,file-stores,exchange-log-file}.ts` and
  `composition/container.ts` (`closeLogs` also waits for the last retention sweep, L6).
- **Step 3.** `bun run verify` exit 0, `GATE: PASS`: typecheck; unit+component+arch 975 tests in 65 files; e2e 267
  tests in 15 files; statements 4193/4193, branches 2867/2867, functions 1006/1006, lines 3444/3444 for
  unit+component, e2e and merged; 11 recon parity checks; docs lint.
- **Step 4, found state.** A daemon (`bun apps/proxy/src/main/cli.ts serve`, pid 1584596) has run from the working
  tree since 2026-10-28 00:40 CST; it wrote `.cache/accounts.json` with fresh sign-ins of `claude` and `openai` and
  rotated `.cache/logs/2026-10-28-1584596-usage{,.1…5}.jsonl` at the 100 MB cap. The move-in is therefore a merge:
  the two providers already in the file are kept, the four others (`antigravity`, `cheaper-inference`, `opencode`,
  `openrouter`) are added from their old files unchanged; all six old files go to
  `~/.local/share/accounts-proxy/backups/accounts-2026-10-26/`. Dry run: 6 files, 4 providers to add, logs
  `exchanges-2026-10-28.jsonl` (1,944,816,788 bytes) and `proxy.log` (782,380 bytes) to move.
- **Step 4, applied (2026-10-28).** The daemon was stopped with SIGTERM (its 2,045 exchange records all parse). The
  move-in (`--apply`) kept `claude` and `openai`, added `antigravity`, `cheaper-inference`, `opencode` and
  `openrouter` unchanged (read back and compared field by field), moved the six old files to the backup folder and
  the two old logs to `.cache/logs/exchanges-2026-10-28.jsonl` and `.cache/logs/proxy-2026-10-28.log`; the file is
  0600, `.cache/` 0700, `.cache/` ignored by git (`.gitignore:10`). The restarted daemon (`bun run proxy serve`,
  pid 123936) answered one request per provider: `claude/claude-haiku-5-5` 200, `antigravity/gemini-2.5-flash` 200,
  `openai/gpt-5.6-terra` 200, `openrouter/minimax/minimax-m3.1-flash` 200, `cheaper-inference/claude-haiku-5.5` 200;
  `opencode/gpt-5.4-mini` and `opencode-go/qwen3.8-flash` 429 `BudgetLimitError` "Policy budget exceeded" (resets
  2026-11-01), the vendor's answer to an accepted credential. Its usage log rotated at the cap
  (`2026-10-28-123936-usage.jsonl` → `.1.jsonl`).
