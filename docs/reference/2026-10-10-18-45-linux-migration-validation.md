# Linux migration validation (2026-10-10)

The project moved from the Windows machine (`C:\Users\Marco\Dev\AIML\inference-router`) to this Linux machine. Every check below was run on 2026-10-10 on `Linux mk15 6.19.14+kali-amd64 x86_64`.

## 1. Paths

| Item | Path | Check | Result |
|---|---|---|---|
| Repo | `/home/mavasbel/Dev/repos/inference-router` | `git status --short --branch` | `main...origin/main`, in sync with `origin` at `9c357f0` (2 uncommitted doc files from 2026-10-07) |
| Remote | `https://github.com/mavasbel/inference-router.git` | `git remote -v` | unchanged |
| Plugin repo (Claude) | `/home/mavasbel/Dev/repos/devtools/opencode-claude-auth` | `git cat-file -t 62927412322eedfd5b1d8f08c4eb894f26e6c50a` | `commit`; HEAD `6292741` |
| Plugin repo (Antigravity) | `/home/mavasbel/Dev/repos/devtools/opencode-antigravity-auth` | `git cat-file -t 5c6f7c2697fdc187bfc1d5f0208b8f5563620875` | `commit`; HEAD `5c6f7c2`, clean |
| Old root `AIML/` | `/home/mavasbel/Dev/AIML` | `ls -d` | absent; nothing in the repo's code depends on it |
| Pre-repo docs (`AIML/tools/docs/…`) | — | search of `/home/mavasbel/Dev/docs`, `/home/mavasbel/Dev/repos/opencode/docs` | absent; the repo's `docs/` holds the plan, research and session record |
| Data directory | `/home/mavasbel/.local/share/inference-router` | `ls` | absent before; created 2026-10-10 with mode 700, `router.yaml` copied from `config/router.example.yaml` (both providers enabled, `acknowledgeTermsRisk: true`) |
| Scratch directory | `/tmp/opencode` | — | replaces `%TEMP%\opencode` |
| Claude Code binary | `/home/mavasbel/.local/bin/claude` → `~/.local/share/claude/versions/2.1.29` | `claude --version` | `2.1.29`, older than the hashed `2.1.280` Windows binary that P0-E6 read; P0-E6 values stay sourced from that binary |

Repo text that still names Windows paths (`git grep` for `C:\`, `AIML/`, `%TEMP%`, `.exe`): all are historical records. Each now carries a migration note (plan v3.1, research, P0-E6, alias plan, PROVENANCE, session record). The only code hit is the comment in `apps/router/src/adapters/outbound/browser-launcher.ts`, which documents the `win32` branch.

## 2. Repository integrity

| Check | Result |
|---|---|
| Line endings: `git ls-files --eol` | 179 files `i/lf w/lf`; 23 `-text` evidence files `i/none w/none`; 0 CRLF files outside the `-text` paths |
| Vendored parity references: `git hash-object --no-filters` vs `MANIFEST.json` | antigravity 10 files, claude 4 files, 0 mismatches |
| `core.fileMode` | `false`. Working files are mode 777 after the copy, and git ignores mode. All 202 index entries are `100644`. |

## 3. Toolchain

| Tool | Path | Version |
|---|---|---|
| Bun | `/home/mavasbel/.bun/bin/bun` | 1.4.2 (pin) |
| Node | `~/.nvm/versions/node/v24.21.0/bin/node` | 24.21.0 |
| git, gh | `/usr/bin/git`, `/usr/bin/gh` | present |

`node_modules` had been installed on Windows: `node_modules/.bin/tsc.exe` was a PE32+ Windows executable. All 8 `node_modules` directories were removed, then `bun install --frozen-lockfile` was run: 144 packages, `bun.lock` byte-identical (`cmp`), and `node_modules/.bin/tsc` is now a Node script.

## 4. Gate on Linux

`bun run verify` (before the provider rename):
- typecheck, unit+component+arch, build and docs lint: PASS;
- 342 tests pass, coverage 100% (statements 1545/1545, branches 1162/1162, functions 347/347, lines 1276/1276). These totals are identical to the Windows run of `9c357f0`.
- e2e and merged coverage: INCOMPLETE (no e2e tier yet), the same as on Windows.

## 5. Linux runtime probes

| Probe | Result |
|---|---|
| Credential file mode (`FileCredentialStore.save` into a temp dir) | `accounts-antigravity.json` mode `600` |
| Port 4141 (`ss -ltn`) | no listener: free |
| `localhost` resolution (`getent ahosts`) | `::1` and `127.0.0.1` |
| A listener on `127.0.0.1` only, reached as `http://localhost:<port>` (curl) | `::1` refused, then `127.0.0.1` succeeded. The login redirect (`http://localhost:<port>/…`) works with the router's 127.0.0.1 listener. Bun's `fetch` reaches it too: the in-process login test passed. |
| Browser opener | `xdg-open` (`/usr/bin/xdg-open`); default browser `firefox-esr.desktop`; `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`. The router's Linux branch spawns `xdg-open <url>` with an argument array (no shell), so `&` in the URL cannot split it. |

## 6. Finding

The router creates its data directory with the process umask (`mkdir` with `recursive: true` and no mode), which here gives 755. The credential files inside are 600, but the directory should be 700, as `~/.ssh` is. This is scheduled as a hardening item (plan [2026-10-10-18-45-continuation-plan.md](../plans/2026-10-10-18-45-continuation-plan.md), step 1).
