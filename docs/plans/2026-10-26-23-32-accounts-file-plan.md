# Plan 2026-10-26-23-32 — one accounts file in `<repo>/.cache/accounts.json`

Status: approved (user decision 2026-10-26, option "One accounts.json"). Runs after the
[exchange log plan](2026-10-26-23-00-exchange-log-plan.md) is committed.

## 1. Goal
Every provider's accounts (sign-ins, API keys, the active account) are kept in one JSON file,
`/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/accounts.json`. The proxy always reads them from it and
always writes them to it, so the file can be edited by hand or copied.

## 2. Facts this plan rests on (measured 2026-10-26 23:32)
| # | Fact | Evidence |
|---|---|---|
| F1 | Accounts are 6 files `accounts-<provider>.json` (0600) in `~/.local/share/accounts-proxy/` | `ls -la ~/.local/share/accounts-proxy/` |
| F2 | The file store reads the file on every `load` and writes only inside `update` under the lock `accounts-<provider>` | `apps/proxy/src/adapters/outbound/file-stores.ts:69-100` |
| F3 | The data directory is `ACCOUNTS_PROXY_HOME`, else `~/.local/share/accounts-proxy` | `apps/proxy/src/composition/container.ts:277-279` |
| F4 | The daemon runs as `bun run proxy serve` with `WorkingDirectory=` the repo and `ACCOUNTS_PROXY_HOME=~/.local/share/accounts-proxy` | `systemctl --user cat accounts-proxy.service` |
| F5 | `.cache/` is not ignored by git | `.gitignore` |
| F6 | AGENTS.md §4 "Own credentials" places the credentials only in `~/.local/share/accounts-proxy/` | AGENTS.md §4 |
| F7 | Claude and OpenAI rotate the refresh token on every renewal | memory #1025, #1124 |

## 3. Decisions
- **A1 File.** `<repo>/.cache/accounts.json`, mode 0600, directory `.cache/` 0700. Shape:
  `{ "schema": "accounts-proxy/accounts/1", "providers": { "<provider>": { "accounts": [...], "activeId"?: "..." } } }`.
  A provider with no accounts is absent. `opencode-go` keeps sharing the `opencode` entry (K2).
- **A2 Repo root.** Resolved from the program's own location: the source entry
  (`apps/proxy/src/main/cli.ts`) and the built bundle (`dist/accounts-proxy.js`) each know their depth below the repo.
  `ACCOUNTS_PROXY_ACCOUNTS_FILE` overrides the path (an absolute path only); the hermetic e2e processes
  (`tests/support/e2e/proxy-process.ts`) set it inside their temporary home, so no test ever touches the real file.
- **A3 Read and write.** Every `load` reads the file (hand edits apply to the next request without a restart). Writes
  stay the locked read → change → write, now under one lock `accounts` (lock order still renewal lock → store lock),
  written atomically (temp file + rename) so a copy taken at any time is a whole file. A file that is not valid JSON
  or not the A1 shape is a `StoreCorruptError` naming the path; it is never overwritten.
- **A3a Locks live with the file** (user requirement 2026-10-26 23:40: every writer of the one file takes a lock).
  Today the lock files are in `<ACCOUNTS_PROXY_HOME>/locks/` (`apps/proxy/src/composition/container.ts:363`,
  `apps/proxy/src/adapters/outbound/file-lock.ts:47`), so two processes with different homes writing the same accounts
  file would not exclude each other. The store lock (`accounts`) and the per-provider renewal locks therefore move to
  `<dir of accounts.json>/locks/`: every process that uses the same accounts file — the daemon, `login`, `account use`,
  `account remove`, a second daemon — takes the same lock files. `FileLock` already excludes both other processes
  (`wx` create, stale after 60 s, timeout 90 s) and other holders in the same process (in-memory queue per name), so
  concurrent requests inside the daemon are serialised too. The renewal lock keeps one refresh per provider at a time
  (single-use refresh tokens, F7); the store lock is held only for read → change → write.
- **A3b Hand edits.** An editor does not take the lock. So that a hand edit saved while the proxy is writing is not
  lost, `update` re-reads the file just before the rename and, if its bytes changed since its read, applies the
  change again to the new content (bounded retries, then an error naming the file). The proxy's own writes are atomic
  (temp file + rename); an editor's half-saved file reads as `StoreCorruptError` for that request only and is never
  overwritten.
- **A4 Git.** `.cache/` is added to `.gitignore`; a test asserts `git check-ignore .cache/accounts.json` succeeds.
- **A5 Move-in.** Once, by hand-verified step (not product code): the 6 files of F1 are merged into the new file; the
  merged pools are compared field by field with the originals; the originals move to
  `~/.local/share/accounts-proxy/backups/accounts-2026-10-26/` (0700) for the user to delete. The daemon is restarted
  and every provider is checked with `bun run proxy status` and one request each.
- **A6 Copying.** A copy used by two running proxies is not supported for `claude` and `openai` (F7): the second to
  renew is signed out. Stated in the README and the providers reference.

## 4. Steps
1. `AccountsFileStore` (outbound adapter extending `CredentialStorePort`) replaces `FileCredentialStore`; composition
   wires it with the A2 path. Unit + component tests: multi-provider load/update, absent file, corrupt file (not
   overwritten), mode 0600/0700, atomic write, one lock name, A3b re-read on a concurrent hand edit.
   Locks (A3a): `FileLock` rooted at `<dir of accounts.json>/locks/`; e2e: two processes with different
   `ACCOUNTS_PROXY_HOME` and the same accounts file renew once (one token-endpoint call) and both writes survive.
2. A2 path resolution in composition, with the env override validated (absolute path; fatal otherwise); e2e support
   sets it; e2e tests updated (`login`, `account`, sessions) to read the one file.
3. `.gitignore` + A4 test.
4. Docs: AGENTS.md §4 "Own credentials" (amended, with this plan linked), README, providers and client-setup
   references, API reference environment table (docs-in-step checks every `ACCOUNTS_PROXY_*` name), diagram names.
5. `bun run verify` (100 % unit+component, e2e, merged).
6. A5 move-in on the live installation, daemon restart, live check per provider, report.
7. Commit and push.

## Amendment (2026-10-27)

F4 is superseded: the systemd user unit `accounts-proxy.service` was removed at the user's request; the daemon runs
from a terminal as `bun run proxy serve` in the repository, with the default data folder `~/.local/share/accounts-proxy`.
