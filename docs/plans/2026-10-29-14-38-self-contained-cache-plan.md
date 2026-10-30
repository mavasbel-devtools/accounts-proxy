# Plan 2026-10-29-14-38 — a self-contained proxy: all data in `<repo>/.cache`

Extends [plan 2026-10-26-23-32](2026-10-26-23-32-accounts-file-plan.md) (the accounts file in `.cache/`) and
[plan 2026-10-27-23-29](2026-10-27-23-29-locked-writes-and-log-files-plan.md) (locks and logs next to it). User
approval: 2026-10-29 ("Can we proceed?" on the D1–D10 proposal; recommended options: drop K5, `AP · <provider>`).

## 1. Measured starting state (2026-10-29)

| Path | Content |
|---|---|
| `<repo>/.cache/` | `accounts.json`, `locks/`, `logs/` |
| `~/.local/share/accounts-proxy/proxy.yaml` | the live config; header still names `inference-router` / `router.yaml` |
| `~/.local/share/accounts-proxy/token.json` | `{ token }`, the proxy token (equal to opencode's stored `http://127.0.0.1:4141` credential) |
| `~/.local/share/accounts-proxy/state/` | 7 `model-catalog.json`, `model-reference.json`, Claude `device-id`, OpenAI `host-id`, Antigravity `session-id`, `thought-signatures` |
| `~/.local/share/accounts-proxy/backups/accounts-2026-10-26/` | the six per-provider account files from before plan 2026-10-26-23-32 |
| `~/.local/share/accounts-proxy/recon/` | `profiles/` (288 MB, the sandbox homes and their sign-ins), `runs/` (4.8 GB) |
| `~/.local/share/accounts-proxy/{logs,locks}/` | empty |

Defaults in code: `apps/proxy/src/composition/container.ts:289-291` (`defaultHome`), `:312-321` (`accountsFileOf`),
`scripts/recon/sandbox/profiles.ts:33-40` (recon root). Both locations are on the same btrfs volume, so every move is a
rename (no copy of a rotating refresh token).

## 2. Steps

| # | Step |
|---|---|
| S1 | Default data directory = `<repo>/.cache` (the repository the program runs from, found as today by `package.json` name). `ACCOUNTS_PROXY_HOME` stays only as the override tests use. Accounts file default = `<home>/accounts.json`; `ACCOUNTS_PROXY_ACCOUNTS_FILE` stays as override. Nothing outside the repo is read by default. |
| S2 | Recon root default = `<repo>/.cache/recon` (`ACCOUNTS_PROXY_RECON_ROOT`, then `ACCOUNTS_PROXY_HOME/recon` stay as overrides). The recon scripts are unchanged otherwise. |
| S3 | Drop decision K5: remove `login <gateway> --from-opencode` and `OpencodeAuthFile` (OpenCode v2 keeps its credentials in `opencode.db`; `auth.json` holds only `opencode-go`). The proxy then reads no other tool's files. |
| S4 | The `/.well-known/opencode` token command loses `env ACCOUNTS_PROXY_HOME=…` when the daemon runs on the default home (it is kept only when an override is in effect, so a test daemon's command still names its own home). |
| S5 | opencode provider names `AP · <provider>` (was `Accounts Proxy · <provider>`). |
| S6 | `config/proxy.example.yaml`: replace the refused `exchangeLog` block with `logs`; the live `proxy.yaml` header gets the current one, settings unchanged. |
| S7 | Tests at 100% (unit+component, e2e, merged), docs (AGENTS.md, README, API, providers, client setup, CLI help, diagram) and `bun run verify`. |
| S8 | Move-in, daemon stopped: rename `proxy.yaml`, `token.json`, `state/`, `recon/` into `.cache/`; check file list, sha256 and modes before and after; confirm by account id that every backup account is in `accounts.json`, then delete `backups/`; remove the emptied `~/.local/share/accounts-proxy/`. |
| S9 | Live: restart the daemon from `.cache`, recon isolation probe `clean`, opencode shows `AP · …` after a restart. Commit, secret audit, push. |

## 3. Execution record

| # | Status | Evidence |
|---|---|---|
| S1–S7 | done | Source, tests and documentation prepared before the move. |
| S8 | done 2026-10-29 17:50 -0600 | Daemon stopped. `proxy.yaml`, `token.json`, `state/`, `recon/` and `backups/` moved by same-filesystem rename into `.cache/`; every active moved item matched its pre-move inventory (path, size, mode and SHA-256). An already-created cache token and one-file cache state differed from the live data, so both were preserved under `.cache/backups/` before the established token and complete state became active. Backups remain because two legacy backup accounts (one Claude, one OpenAI) are not in `accounts.json`. The empty legacy `locks/` and `logs/` directories and their parent were removed. |
| S9 | done 2026-10-30 08:35 CST | All seven providers refreshed from their live lists (12 Claude, 21 Antigravity, 8 OpenAI, 456 OpenRouter, 130 OpenCode, 37 OpenCode Go, 340 Cheaper Inference). The recon isolation probe was clean and unchanged for all four clients. The daemon runs from `.cache/` on `127.0.0.1:4141`. `bun run verify` passed: typecheck, unit/component/architecture 100%, build, e2e 100%, merged 100%, 11 recon parity checks and docs lint. Secret/identity audit passed clean with zero hits on personal identifiers or credentials. Staged changes committed as `2a49cec` and pushed to `origin/main`. |
