# Plan — pi compatibility (pi configuration, well-known manifest, pi extension)

- Plan file: `/Users/mavasbel/Dev/repos/devtools/accounts-proxy/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`
  (moved into the worktree at step 0.2: `{worktree}/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`)
- Created: `2026-11-15-23-52` (local time, from `date +%Y-%m-%d-%H-%M`)
- Status: draft, awaiting approval
- Repository `{repo}`: `/Users/mavasbel/Dev/repos/devtools/accounts-proxy`
- Worktree and branch `{worktree}`: `/Users/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-pi-compatibility`
  (`feat-pi-compatibility`)
- Session record `{record}`: `{worktree}/docs/sessions/{session_id}.md`, where `{session_id}` is the executing
  session's id; the planning record is `{repo}/docs/sessions/ses_e1d2bb206ffeA1ncekZZy0G4WO.md` (moved at step 0.2)
- Executed against: local `main` at commit `{base}` = `0fd623a884de8576ab95bfae9f937eadbb4f17b2`
  (evidence: `git -C {repo} rev-parse main`, 2026-11-15). `origin/main` is `b0eea06d6ea63d2283463a19221fe123545af950`;
  local `main` is 7 commits ahead and unpushed, so the worktree starts from local `main`, never from `origin/main`.
- Plan SHA-256 at approval: `{plan_sha256}`, written in the approval request; `build` re-computes
  `shasum -a 256 {repo}/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md` before step 0.1 and stops on any
  difference. The file is hashed exactly as it is, with this line reading `{plan_sha256}` literally; `build` never
  edits the plan.
- Baseline gate `{baseline}`: `bun run verify` on the unchanged worktree (step 0.6), output in `{record}` § Baseline gate.
- Scratch directory `{logs}`: `/private/var/folders/_m/jyv5nmsn4y305mjjcm_4fq240000gn/T/opencode/2026-11-15-23-52-pi-compatibility`
  (outside the repository; created at step 0.5 with `mkdir -p` and mode `700`; deleted at step 9.6).
- Design: `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md` (use cases uc-pi-1 … uc-pi-6, rules
  P1–P7) and `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-architecture.md` (every name used below).
- Bun: `{bun}` = `/Users/mavasbel/.bun/bin/bun` (1.4.4); `{pi}` = `/opt/homebrew/bin/pi` (1.5.2).

## Amendment 1 (approved 2026-11-16; amendment file SHA-256
  `8464e00cea49d58a3b3de879738f2d4908da6f91e03a0a41dc963f6dc6e016a1`; base plan verified unchanged at
  `9a15f83ddfd8eae9ddafb7bc4818965cd66b416b79dca2971df49dfafdbbabc2`)

Status on 2026-11-16 11:34 (after the opencode restart): stages 0–3 green and committed
(`63c30fe`, `4cd4567`, `e4cee89`, `fd921a0`); steps 4.1–4.6 green, not committed; step 4.7 green with the A1
deviation (8 pass / 0 fail, re-run by the main session); step 4.8 (the full e2e run) in progress behind the A2
guard; steps 4.9 onward not started. The user's daemon (pid 96176) runs untouched. 50 temporary directories
leak under `$TMPDIR` (all born after the plan's first commit); they are A4's known residue.

### A1 — Step 4.7: the darwin `open` fake (already applied, user-approved 2026-11-16)

**Known**: on darwin `browserCommand` spawns `open`
(`apps/proxy/src/adapters/outbound/browser-launcher.ts:15`); `makeHome` fakes only `xdg-open`
(`tests/support/e2e/proxy-process.ts:146-147`). So `startSignedInDaemon` can never sign in on this Mac.
**Change**: step 4.7 content replaces "`startSignedInDaemon`" with: "`makeHome`, then an `open` fake in
`home.bin` in the exact form of the `xdg-open` fake, then the logins, `token` and `startDaemon` that
`startSignedInDaemon` (proxy-process.ts:258-267) runs". Gate unchanged: 8 tests, exit `0`.
**Not changed**: the harness. A fix in `makeHome` is out of scope and listed in A6 as follow-up.

### A2 — Every full e2e run on this Mac runs behind the browser guard

**Known**: each old login test spawns the real `open`, so one full e2e run opened many browser tabs (user report
2026-11-16). **Change**: steps 4.8, 4.9, 5.8, 5.9 and 9.1 prefix their command with
`PATH="{logs}/no-browser-bin:$PATH"`, where `{logs}/no-browser-bin/open` is `#!/bin/sh` + `exit 0`, mode `755`.
New gate in each: before the run, `PATH="{logs}/no-browser-bin:$PATH" command -v open` prints
`{logs}/no-browser-bin/open`. **Why the baseline comparison still holds**: the launcher is fire-and-forget; with
or without the guard the old login tests fail with the same `CallbackTimeoutError` after 30 s.
**Rule for every brief**: no subagent runs `test:e2e`, `verify` or a login-based test without this prefix.

### A3 — Stage 8 at minimal spend (user decision "Minimal", 2026-11-16; cheapest model everywhere, user directive 2026-11-16)

New **step 8.0 — read the cost controls** (subagent `explore`, action `read`, target pi 1.5.2 at
`/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`). It must
learn: (1) whether a test-local `models.json` `modelOverrides` entry with `maxTokens` caps the output tokens pi
requests on each of the four apis, and the smallest `maxTokens` a thinking turn accepts on `anthropic-messages`
(budget thinking is capped at `maxTokens - 1024`); (2) the exact flag set that shrinks every live turn. Known
from `pi --help` (2026-11-16): `--system-prompt <text>`, `--tools <list>`, `--no-context-files`, `--no-skills`,
`--no-prompt-templates`, `--no-mcp`, `--no-extensions` (explicit `-e` still loads), `--thinking <level>`.
**Gates**: each answer has its file and line. **Consumed by** 8.1.

**Step 8.1 changes**: every pi run uses `--system-prompt "Answer in one word."`, `--tools read`,
`--no-context-files`, `--no-skills`, `--no-prompt-templates`, `--no-mcp`, `--no-extensions`, plus the output cap
8.0 found. Per cell, ONE paid turn: the tool turn (b), which also proves the plain path (a), so (a) is removed.
Output cap 32 tokens, or the smallest value 8.0 found to work. Thinking turn (c) runs once per pi api (4 turns),
on the cheapest reasoning model of that api, at the LOWEST level its map allows (not `:high`). Negatives (d) and
(e) stay; they cost nothing (rejected before any upstream call). `pi-binary.test.ts` uc-pi-5 positive stays as one
turn; uc-pi-4 and uc-pi-2/uc-pi-6 make no model call.

**Model choice: the cheapest model possible, in every cell and every turn.** Replaces the plan's "Cells and
models" rule: rank the cell's models in `{logs}/catalog.json` by `cost.input + cost.output` ascending (a free
model, cost 0, ranks first), ties by `cost.cache_read`, then by id; pick the first one with `toolCall: true`. This
applies to the subscription cells too (claude, antigravity, openai): their quota is spent per token as well, so
the cheapest list price wins over the plan's named models (`claude-haiku-5-5`, `gemini-3-flash`, `gpt-5.6-luna`
stay only if they rank first). Thinking turn: the cheapest model of that api with `reasoning: true`, by the same
ranking, at the lowest level. The first cell run in 8.3 is the cheapest cell of the whole table. The derivation
script prints the full ranking per cell (top 3 with prices) into `returns`. **Problem**: the cheapest model
answers 429 or 5xx (free models are often rate-limited) or cannot call the tool → take the next model in the
ranking, once per failure, recorded with the error; never a more expensive tier than the next in line, never drop
the cell.

**Step 8.3 changes**: the tier runs in two halves. First one cell (the cheapest cell of the table), then the main
session reads its spend from the proxy's cost log (`bun run proxy cost`). Ceiling = that spend × 22 (17 tool turns
+ 4 thinking turns + 1 binary turn). The main session asks the user before the rest of the tier runs if the
projected total is above the ceiling or above 1 USD. **Result**: 22 paid turns instead of 51.

### A4 — Residue (new `AGENTS.md` 3.10 and 4.9)

**Known**: the plan predates rule 3.10, so no marker and no before-listing exist; they cannot be made
retroactively. New **step 4.8a** (main session, before 4.9): create `{logs}/marker` and record the before-listing
of rule 3.10 (`$TMPDIR`, `/tmp`, `~/.opencode/plan/`, `~/.pi`, `{repo}/.cache` names only, and for the repository
`git status --porcelain --ignored`, `git worktree list`, `git branch --all`, `git stash list`). **Known residue
already** (by birth time after `07c67e0`, 00:19:12): the 50 directories `$TMPDIR/accounts-proxy-*`. The residue
step deletes each one by its absolute path once no test runs, and proves each with `test ! -e`. **Retained**:
the branch until integration; `{repo}/.cache` (the user's live data); `~/.pi/agent/settings.json` change of step
9.5 (deliverable of the request). **Scratch to delete**: `{logs}` (deleted last, `test ! -e`);
`/Users/mavasbel/.opencode/plan/2026-11-16-11-42-pi-compatibility-plan-amendment-1.md` (after it is copied into the
plan). New **step 9.6a — residue**, before the final record: the scan of rule 3.10 against the marker, plus the 50
directories above; gate: every new path is a deliverable or retained, every deletion has its `test ! -e` output.
**Briefs from now on** (rule 4.9): each brief gets `{logs}/briefs/<step>/` and returns every path it created,
changed or deleted.

### A5 — Recorded deviations already accepted

Step 3.1 gate 1: the `bun.lock` rewrite by Bun 1.4.4 is accepted (format only, 12 entries verified). Unscoped
`test` and `coverage` gates: rule R2 (exactly the 9 baseline failures) stands.

### A6 — Out of scope, reported as follow-ups

`makeHome` should fake `open` on darwin (today every login-based e2e test fails on this Mac). Bun pin 1.4.2 vs
host 1.4.4.

### Edits this amendment makes to the steps below (the `build` agent applies each one when it reaches the step)

- Step 4.7: its `content` reads "`makeHome`, then an `open` fake in `home.bin` in the exact form of the
  `xdg-open` fake, then the logins, `token` and `startDaemon` that `startSignedInDaemon`
  (proxy-process.ts:258-267) runs" (applied in `pi-routing.test.ts`).
- Steps 4.8, 4.9, 5.8, 5.9, 9.1: each `content` starts with
  `PATH="{logs}/no-browser-bin:$PATH"` (guard file already created at `{logs}/no-browser-bin/open`, 755) and
  each gains the `command -v open` gate named in A2.
- Stage 8: new step 8.0 before 8.1; steps 8.1 and 8.3 as rewritten in A3.
- Step 4.8a and step 9.6a are added as named in A4.
- Steps 8.2, 8.4, 8.5 are unchanged.

## Amendment 2 (approved 2026-11-16; amendment file SHA-256
  `19cebbbc78a41c1f3c97f82951fc96a3db7812fcc0de42be9b19f073a3047927`; base plan verified unchanged at
  `b73feda62e16e5ead48aa10695029353659131eac049734ac94f086de1156b2f`)

- Plan: `/Users/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-pi-compatibility/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`
- Base plan SHA-256 (with amendment 1 copied in, verified 2026-11-16 14:15):
  `b73feda62e16e5ead48aa10695029353659131eac049734ac94f086de1156b2f`
- Applies on top of amendment 1. Where the two differ, this amendment wins.
- Written by the `plan` agent on 2026-11-16 at 14:15. When it is approved, the `build` agent copies it into the plan
  under `## Amendment 2`, right after amendment 1, and records the new plan SHA-256 in `{record}`.

## Status when this was written

- Stages 0–7 are green and committed. The last stage commit is `b091aef`, and the record commit is `e184f85`.
- Step 8.1's eight live files exist but are not committed:
  `{worktree}/apps/pi-extension/tests/live/{pi-binary,pi-claude,pi-antigravity,pi-openai,pi-openrouter,pi-opencode,pi-opencode-go,pi-cheaper-inference}.test.ts`
  (57 tests, all skipped without the flag; `GRANULARITY: PASS (146 scenarios)`).
- Step 8.2 has been blocked since 2026-11-16. The user's daemon (pid 96176, `127.0.0.1:4141`) serves the user's own
  opencode session, so it cannot be stopped.
- The user's direction (2026-11-16): never stop the current daemon. Start a disposable daemon from the worktree on
  another port instead.

## Known (each fact with its evidence)

| # | Fact | Evidence |
|---|---|---|
| K1 | More than one process may use one accounts file; the design covers this. A renewal runs under a cross-process lock that re-reads the pool first, so a renewal another process already did is reused, not repeated. A renewed credential is written by a locked read-change-write. | `packages/core/src/ports/outbound/session.ts:5-10,61-110`; `packages/core/src/domain/accounts.ts:25-30` (the token-call deadline stays under the 60 s lock staleness "or two processes could spend the same refresh token"); `apps/proxy/src/adapters/outbound/file-lock.ts:1-4,45-70` (an `O_CREAT|O_EXCL` lock file) |
| K2 | The accounts file is read on every use and written only by a locked, atomic read-change-write. Every process takes the lock files under `locks/`. | `docs/reference/2026-10-17-19-26-proxy-api.md:188-189` |
| K3 | The project documents a second daemon as a supported pattern: `ACCOUNTS_PROXY_HOME=/tmp/opencode/ap-test bun run proxy serve` ("run a separate daemon with its own data directory"). | `apps/proxy/src/adapters/inbound/cli/commands/daemon-commands.ts:27` |
| K4 | The port comes only from `<home>/proxy.yaml` `port`. A busy port stops the daemon; it never picks another port. | `proxy-api.md:15-16,167` |
| K5 | `locks/` and `logs/` sit next to the accounts file. `proxy.yaml`, `token.json` and `state/` sit in `ACCOUNTS_PROXY_HOME`. | `apps/proxy/src/composition/container.ts:266-268,340,417-420`; `apps/proxy/src/adapters/outbound/file-stores.ts:214,237` |
| K6 | When `ACCOUNTS_PROXY_HOME` is set, the manifest's token command starts with `env ACCOUNTS_PROXY_HOME=<home>`. So pi gets the disposable daemon's token, never the user's. | `container.ts:283-286,298-300` |
| K7 | Every live file reads `ACCOUNTS_PROXY_URL` (default `http://127.0.0.1:4141`). | for example `apps/pi-extension/tests/live/pi-claude.test.ts:18`, `pi-binary.test.ts:19` |
| K8 | `test:live` runs every workspace's `tests/live`. The only other live file is `apps/proxy/tests/live/cost-reconcile.test.ts`, which runs `opencode stats` locally and makes no model call. | `scripts/gate/run-tests.ts:5,106-112`; glob `**/tests/live/**/*.ts` → 9 files |
| K9 | The user's `proxy.yaml` has exactly one top-level `port:` line and no `usage:` key, so the usage log is on (default `true`). Its SHA-256 is `c1ede66f4d2902ad354077611ba50ae84fe016cb3031b0942f6a0952c610a1f1`, the same as at step 0.4. | `grep -c '^port:'` → `1`; `grep -E '^\s*usage:'` → nothing; `shasum` 2026-11-16 14:15; `proxy-api.md:172` |
| K10 | Usage files are named `logs/<day>-<pid>-usage[.N].jsonl` and `logs/<day>-<pid>-proxy[.N].log`. | `proxy-api.md:193-194`; the listing shows `.cache/logs/2026-11-16-96176-usage.47.jsonl` |
| K11 | Ports 4142, 4143 and 4144 had no listener at 14:15. | `lsof -nP -iTCP:<p> -sTCP:LISTEN \| wc -l` → `0` for each |
| K12 | **The build did not follow amendment 1.** Step 8.0 never ran. The 8.1 files implement the base step 8.1, not A3: they keep the plain turns (a), run a thinking turn in every cell instead of once per pi api, cap output at `MAX_TOKENS` (64) instead of 32, and keep the named subscription models instead of ranking by price. | for example `pi-claude.test.ts:98,110,127`; `pi-opencode.test.ts:45-49`; `pi-binary.test.ts:193` |
| K13 | After the merge, `{repo}`'s `node_modules` has no link for the new workspaces (`dialect-pi`, `pi-extension`). The original plan has no install step in `{repo}`, so a restart of the user's daemon after the merge would fail to resolve `@accounts-proxy/dialect-pi`. | Steps 3.1 and 5.1 linked them only in `{worktree}`; step 9.4 runs no `bun install` (plan lines 1546-1564) |

## Inferred (and from what)

- **I1.** A second daemon on the same accounts file is the same situation as any CLI command that runs beside the
  daemon (`login`, `models --refresh`, `quota`). K1 and K2 make the renewal safe both ways: the user's daemon re-reads
  a token that the disposable daemon renewed, and the reverse.
- **I2.** The disposable daemon runs the log-retention sweep over the shared `logs/` with the same values as the user's
  daemon, because `proxy.yaml` is copied. So the sweep deletes only what the user's next sweep would delete anyway.
- **I3.** A separate `token.json` isolates the two daemons. A test request sent to `:4141` by mistake gets 401 and
  spends nothing.

## Not known (and what would verify it)

- **N1.** Whether an upstream treats a second process with the same device and session ids as unusual. Copying
  `state/` keeps the ids identical, so the upstream sees the same install. No live evidence exists either way.
- **N2.** Whether `opencode` and `opencode-go` charge anything for the free models: no `quota` command reports their
  usage. The ranking picks cost-0 models, and the usage log's `usage.raw.cost` is the only measure.

## Decisions

- **D1 — The disposable daemon.**
  - It runs from `{worktree}` on `{live_port}`, the first free port of 4142–4149, chosen and recorded in step 8.2.
  - Its data directory is `{live_home}` = `{logs}/live-home`, mode `700`. It holds:
    - `proxy.yaml`: the user's file with the `port:` line replaced, mode `600`, never printed;
    - `state/`: copied from `{repo}/.cache/state` with `cp -Rp`, so the device and session ids stay identical (N1);
    - `token.json`: created by `serve` itself, never copied.
  - `ACCOUNTS_PROXY_ACCOUNTS_FILE=/Users/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/accounts.json` shares the
    accounts file and, with it, `locks/` (K5). **The accounts file is never copied:** a renewal on a copy would rotate
    the refresh token and invalidate the token in the user's file.
- **D2 — Never touch the user's daemon.** No step stops, signals, restarts or sends a request to pid 96176 or to
  `:4141`. A gate in each of steps 8.2–8.5 and 9.5 proves that pid 96176 still listens on `127.0.0.1:4141`.
- **D3 — The only residue in `{repo}/.cache`** is the disposable daemon's own log files, `logs/*-<livepid>-*`.
  - The lock files are removed on release (`file-lock.ts:65-69`).
  - The log files are copied to `{logs}/live-logs/`, then deleted one by one by absolute path, and each deletion is
    proved with `test ! -e`.
  - Nothing in `.cache` is retained.
- **D4 — Spend is measured on the disposable pid alone.**
  - The `cost` command reads `logs/` next to the accounts file (K5). It therefore runs over a copy:
    `ACCOUNTS_PROXY_HOME={logs}/cost-home`, whose `logs/` holds only copies of `*-<livepid>-usage*.jsonl`.
  - The key-based gateways are measured at the source: `quota openrouter` and `quota cheaper-inference` run before
    and after the live run.
- **D5 — Step 9.5 needs no restart.**
  - The user's pi is proved against a second disposable daemon started from the merged `{repo}`.
  - `:4141` serves the new routes after the user's own next restart. That check is a pending follow-up, not a
    blocker.
  - Until that restart, the user's pi prints the extension's one warning and starts normally. This is the uc-pi-4
    negative path, proved in steps 5.7 and 8.3.
- **D6 — Close the K12 deviation before any paid turn.** Step 8.0 runs, and step 8.1 is reopened to bring the files to
  A3. Paid turns:

  | Paid turns | What they are |
  |---|---|
  | 12 | one tool turn in each of the 12 cells that have a `toolCall: true` model |
  | 2 | a plain turn in each `cheaper-inference` cell, which has no `toolCall` model |
  | 4 | one thinking turn per pi api |
  | 1 | the binary turn |
  | **19** | **total** |

  A3 assumed 22 paid turns, but three cells are absent from the catalog (step 8.1 returns). The A3 ceiling factor
  therefore becomes 19.

## New and rewritten steps

`{live_port}`, `{live_home}`, `{livepid}` and `{livepid2}` are recorded in `{record}` by the step that creates them and
used unchanged afterwards. `{user_daemon_gate}` is the command
`lsof -nP -iTCP:4141 -sTCP:LISTEN -Fp | grep -x p96176` and its expected output, `p96176`.

### Step 8.0 — Read the cost controls (A3, not yet run)

- **runs in**: subagent `explore`
- **action**: `read`
- **target**: pi 1.5.2 at `/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`
- **content**: as written in A3, items (1) and (2), plus (3): does `models.json` `modelOverrides` apply to models that
  an extension registered (the composition order)? The brief's scratch directory is `{logs}/briefs/8.0/`.
- **depends on**: stage 7
- **gates**: 1. each answer has its file and line, and the main session re-reads each cited line.
- **problems**: the cap does not reach extension models → step 8.1r caps through the extension's document instead,
  and asks E1 first.
- **escalation**: E1
- **failure**: step 8.1r does not start.
- **returns**: the three answers with their files and lines.

### Step 8.1r — Bring the live files to A3

- **runs in**: subagent `general`
- **action**: `edit`
- **target**: `{worktree}/apps/pi-extension/tests/live/` (the 8 files)
- **content**: the A3 rules applied to the files:
  - One tool turn (b) in each cell that has a `toolCall: true` model, and no (a) turn there.
  - The (a) turn only in the two `cheaper-inference` cells, on the first model of the A3 ranking.
  - One thinking turn (c) per pi api: on the cheapest `reasoning: true` model of that api across the whole table, at
    its lowest mapped level, placed in that model's provider file.
  - Cheapest model everywhere by the A3 ranking, the subscription cells included, derived by a script over
    `{logs}/catalog.json` with the real codec. The script prints the top 3 of each cell with their prices.
  - Output cap 32 tokens, or the smallest value step 8.0 found to work.
  - Negatives (d) and (e) unchanged; uc-pi-4 and uc-pi-6 unchanged; the binary turn uses the cheapest claude model.
  - No file reads `{repo}/.cache`, and no file presets `ACCOUNTS_PROXY_TOKEN` except the wrong-token negatives.

  The brief's scratch directory is `{logs}/briefs/8.1r/`.
- **depends on**: 8.0
- **gates**:
  1. `{bun} run typecheck` → exit `0`
  2. `{bun} test apps/pi-extension/tests/live` without `ACCOUNTS_PROXY_LIVE` → exit `0`, every test skipped
  3. `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS`
  4. the returns table lists exactly 19 paid-turn tests by name, and the main session counts them in the files
  5. `grep -rn '\.cache' {target}` → no output
- **problems**:
  - a dependency loses its live positive → keep one tool turn there. Granularity wins over spend, and the extra turn
    is recorded.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- apps/pi-extension/tests/live`. The files are untracked, so the
  rollback restores them from `{logs}/briefs/8.1r/before/`, a copy taken first.
- **returns**: the diff, the ranking per cell, the 19-turn table and the gate outputs.

### Step 8.2r — Start the disposable daemon (replaces 8.2)

- **runs in**: main session — the user's accounts file is shared (`AGENTS.md` 4.7)
- **action**: `run`
- **target**: `{live_home}` and a `serve` process on `{live_port}`
- **content**, in order:
  1. Run `{user_daemon_gate}`. Record the names of `{repo}/.cache/logs` and `{repo}/.cache/locks` to
     `{logs}/cache-before.txt`.
  2. Choose `{live_port}`: the first `p` in 4142–4149 for which `lsof -nP -iTCP:$p -sTCP:LISTEN` prints nothing.
  3. Build the data directory:
     `mkdir -m 700 {live_home}`;
     `grep -v '^port:' {repo}/.cache/proxy.yaml > {live_home}/proxy.yaml`;
     `printf 'port: %s\n' {live_port} >> {live_home}/proxy.yaml`;
     `chmod 600 {live_home}/proxy.yaml`;
     `cp -Rp {repo}/.cache/state {live_home}/state`.
  4. Start the daemon as a background shell task:
     `cd {worktree} && ACCOUNTS_PROXY_HOME={live_home} ACCOUNTS_PROXY_ACCOUNTS_FILE=/Users/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/accounts.json {bun} run proxy serve > {logs}/live-daemon.log 2>&1`.
     Record `{livepid}` = the pid that `lsof -tiTCP:{live_port} -sTCP:LISTEN` prints.
  5. Record the key-gateway quotas before the run, with the same two variables:
     `{bun} run proxy quota openrouter` and `{bun} run proxy quota cheaper-inference`, to `{logs}/quota-before.txt`.
     The quota commands are other processes, so their own log files `*-<quotapid>-*` join the D3 residue list; each
     pid is recorded.
- **depends on**: 8.1r
- **gates**:
  1. `{user_daemon_gate}` → `p96176`, before and after
  2. `diff <(grep -v '^port:' {repo}/.cache/proxy.yaml) <(grep -v '^port:' {live_home}/proxy.yaml)` → no output, and
     `grep -x "port: {live_port}" {live_home}/proxy.yaml` → one line (these compare structure; no content is printed)
  3. `curl -s http://127.0.0.1:{live_port}/health` → `"status":"ok"` with the same 7 providers as `:4141`
  4. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:{live_port}/.well-known/pi` → `200`
  5. Token isolation:
     - run the manifest's `auth.command` and pipe its output to `shasum -a 256`; the hash equals
       `jq -r .token {live_home}/token.json | shasum -a 256`;
     - `cmp -s {live_home}/token.json {repo}/.cache/token.json` exits `1`, so the two tokens differ;
     - no token is ever printed.
  6. `stat -f '%Sp' {live_home} {live_home}/proxy.yaml` → `drwx------`, `-rw-------`
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | All of 4142–4149 are busy | other local services | stop and ask the user for a port; never pick one outside the range |
  | `serve` exits with a config error | the user's `proxy.yaml` has a key in a form the `grep` changed | stop the daemon; E1 with the error line only, never the file |
  | `/health` lists fewer providers | a provider failed to start | stop; E1 with the `live-daemon.log` lines that name it |

- **escalation**: E1 to the user
- **failure**: `kill -INT {livepid}`, then step 8.5r runs.
- **returns**: n/a

### Step 8.3 — Run the live tier (content and gates changed)

- The A3 two halves stay, with the A3 ceiling factor 19 (D6).
- **Environment of every run:** `cd {worktree} && env -u ACCOUNTS_PROXY_TOKEN ACCOUNTS_PROXY_URL=http://127.0.0.1:{live_port} ACCOUNTS_PROXY_LIVE=1`.
- **First half:** `{bun} test <file of the cheapest cell> -t '<its tool-turn name>'`.
- **Spend check:**
  - copy `{repo}/.cache/logs/*-{livepid}-usage*.jsonl` to `{logs}/cost-home/logs/`;
  - run `ACCOUNTS_PROXY_HOME={logs}/cost-home {bun} run proxy cost --json`;
  - its exchange count equals the turns that ran;
  - the ceiling equals that spend × 19;
  - ask the user before continuing if the projection is above the ceiling or above 1 USD.
- **Second half:** `{bun} run test:live > {logs}/live.log 2>&1; echo "exit=$?"`, with the same variables.
- **After:**
  - repeat the quotas to `{logs}/quota-after.txt`;
  - repeat the `cost` run over the full copy;
  - paste the before/after quota deltas and the total cost into `{record}` § Live.
- **New gate:** `{user_daemon_gate}` → `p96176` after each half.
- The original gates 1–3 and the original problems table stand.

### Step 8.4r — Prove the user's data untouched (replaces 8.4)

- **runs in**: main session
- **action**: `review`
- **target**: `{repo}/.cache` (names, modes and checksums only)
- **content**: as in 8.4, plus:
  - `{logs}/cache-before.txt` compared with the names now present: new names may only be `logs/*-{livepid}-*` and
    the quota pids' files;
  - `locks/` holds the same names as before;
  - `token.json` checksum and `proxy.yaml` checksum equal step 0.4 (`proxy.yaml`
    `c1ede66f4d2902ad354077611ba50ae84fe016cb3031b0942f6a0952c610a1f1`);
  - `jq 'keys'` of the accounts file → `["providers","schema"]`.
- **depends on**: 8.3
- **gates**:
  1. every comparison equal
  2. `{user_daemon_gate}` → `p96176`
- **problems**: a difference → report both outputs to the user; never repair it by hand.
- **escalation**: the user
- **failure**: reported, not repaired.
- **returns**: n/a

### Step 8.5r — Stop the disposable daemon and remove its residue (replaces 8.5)

- **runs in**: main session — deletions inside the user's live data directory (`AGENTS.md` 4.7)
- **action**: `delete`
- **target**: `{livepid}`, `{live_home}`, `{repo}/.cache/logs/*-{livepid}-*` and the quota pids' files
- **content**, in order:
  1. `kill -INT {livepid}`; after 10 s without exit, `kill -TERM`, recorded.
  2. Copy each residue log to `{logs}/live-logs/`.
  3. List the residue by name: `ls {repo}/.cache/logs | grep -E -- '-({livepid}|<quotapid>…)-'`, and only names born
     after `{logs}/marker`, compared with `-newer`.
  4. Delete each listed name by its absolute path; never by a pattern.
  5. `rm -rf {live_home}`.
- **depends on**: 8.4r (and it runs even when 8.3 failed)
- **gates**:
  1. `kill -0 {livepid}` → fails
  2. `lsof -nP -iTCP:{live_port}` → nothing
  3. `test ! -e <path>` → `0`, once for each deleted log file and for `{live_home}`, all pasted
  4. `{user_daemon_gate}` → `p96176`; `curl -s http://127.0.0.1:4141/health` → ok
- **problems**: a listed log file predates the marker → it is not ours. Report it with its birth and change times and
  never delete it (`AGENTS.md` 3.10).
- **escalation**: the user
- **failure**: the residue is reported by path.
- **returns**: n/a

### Step 8.6 — Stage 8 gate (changed)

- New gate 4: the live table names `{live_port}` and `{livepid}`, the 19 paid turns and the spend figures.
- The other gates stand.

### Step 9.4a — Link the new workspaces in `{repo}` (new; closes K13)

- **runs in**: main session — `{repo}` is the user's live checkout, and their daemon runs from it
- **action**: `run`
- **target**: `{repo}`
- **content**: after the merge, `cd {repo} && {bun} install --frozen-lockfile`. The lockfile is frozen and already
  holds the merged entries, so no installed version changes; only the workspace links are added. The running daemon
  has its modules loaded already and keeps them (D2: it is never restarted by this plan).
- **depends on**: 9.4 (the merge path; with a pull request this step waits for the merge, recorded as pending)
- **gates**:
  1. exit `0`
  2. `git -C {repo} status --short` → the two pre-existing entries only
  3. `test -L {repo}/apps/proxy/node_modules/@accounts-proxy/dialect-pi` → `0`
  4. `{user_daemon_gate}` → `p96176`; `curl -s http://127.0.0.1:4141/health` → ok
- **problems**: the install wants to change the lockfile → stop; E1 (never `--no-frozen-lockfile`).
- **escalation**: the user
- **failure**: `git -C {repo} checkout -- bun.lock`; the links are left for the user's next restart and reported.
- **returns**: n/a

### Step 9.5r — Configure the user's pi without a restart (replaces 9.5)

- **runs in**: main session — the user's own pi configuration
- **action**: `run`
- **target**: `/Users/mavasbel/.pi/agent/settings.json`
- **content**, in order:
  1. Copy `settings.json` to `{logs}/settings.json.before`. Record the names under `/Users/mavasbel/.pi` to
     `{logs}/pi-before.txt`.
  2. Run `pi install /Users/mavasbel/Dev/repos/devtools/accounts-proxy/apps/pi-extension`.
  3. Start the second disposable daemon exactly as step 8.2r does, but from `{repo}` (the merged code) instead of
     `{worktree}`. Record its pid as `{livepid2}`.
  4. Prove the user's pi, with its real agent directory, against that daemon:
     `ACCOUNTS_PROXY_URL=http://127.0.0.1:{live_port} pi --no-session --list-models ap-`, then one `-p` turn on the
     cheapest claude model from step 8.1r: "Reply with exactly: OK".
  5. Stop and clean up as step 8.5r does, for `{livepid2}`.
- **depends on**: 9.4a
- **gates**:
  1. `grep -c 'apps/pi-extension' /Users/mavasbel/.pi/agent/settings.json` → `1` or more
  2. the list shows every available `ap-` provider
  3. the turn prints `OK`
  4. `test ! -e /Users/mavasbel/.pi/agent/models.json` → `0`
  5. every new name under `~/.pi` other than `settings.json` is reported (not deleted unless provably created by
     this step, after the marker)
  6. the 8.5r gates for `{livepid2}`
  7. `{user_daemon_gate}` → `p96176` throughout
- **Pending follow-up**, recorded in `{record}` and in the final report: after the user's own next restart of their
  daemon, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4141/.well-known/pi` → `200`, and `pi --list-models
  ap-` with no `ACCOUNTS_PROXY_URL` lists the providers. Until then, pi starts with the extension's single warning.
- **escalation**: the user
- **failure**: `cp {logs}/settings.json.before /Users/mavasbel/.pi/agent/settings.json`; gate `cmp -s` → `0`.
- **returns**: n/a

## Edits this amendment makes to the plan

1. Step 8.2 problems row "never run two daemons on one accounts file" → replaced by D1, with evidence K1–K3. Two
   daemons share one accounts file safely. Two daemons never share one data directory or one port.
2. Steps 8.2, 8.4, 8.5 and 9.5 → replaced by 8.2r, 8.4r, 8.5r and 9.5r. Step 8.0 runs as written above. Step 8.1 is
   reopened as 8.1r. Steps 8.3 and 8.6 change as written above. Step 9.4a is new.
3. The stage 8 "What" → "the user's daemon untouched (D2)" replaces "the user's daemon restored".
4. A4 residue lists:
   - add `{live_home}`, `{logs}/cost-home`, `{logs}/live-logs`, `{logs}/cache-before.txt`, `{logs}/pi-before.txt`,
     `{logs}/quota-*.txt` (all inside `{logs}`, deleted at 9.6);
   - add the `{repo}/.cache/logs/*-<pid>-*` files of `{livepid}`, `{livepid2}` and the quota pids (deleted at
     8.5r/9.5r);
   - add this amendment file, deleted after it is copied into the plan.
5. A6 follow-ups: add "`:4141` serves `/.well-known/pi` after the user's next restart (step 9.5r)".
6. User actions in the plan → none until step 9.4 (the merge or pull-request choice). The step 8.2 handoff and the
   step 9.5 restart are gone.

## Loop record (plan agent)

- **Pass 1** found four items:
  - K12 (the A3 deviation) → D6 and steps 8.0 and 8.1r;
  - K13 (a restart after the merge would fail) → step 9.4a;
  - spend on the key gateways invisible to `cost` → the D4 quotas;
  - the quota commands' own log files → added to D3.
- **Pass 2** found one item: the step 9.5 restart contradicted D2 → step 9.5r with the second disposable daemon and
  the follow-up.
- **Passes 3 and 4** were clean. Every placeholder is defined in this document. No step depends on a later one. Every
  deletion names an absolute path or a recorded pid and has its `test ! -e` gate.

## Objective

**Why.** pi takes custom models from `~/.pi/agent/models.json` or from an extension, one `api` and one `baseUrl` per
model (pi `docs/models-configuration.md:9-57`). The proxy serves 994 models (live `GET /proxy/v1/models`,
2026-11-15) in formats that differ per provider and per model, and never translates between formats (`AGENTS.md` §1).
The repository describes itself to opencode (`packages/dialect-opencode`, `GET /opencode/config.json`,
`GET /.well-known/opencode`) but has no pi support: no plan, design, code or document mentions pi (search of
`docs/`, `README.md`, `AGENTS.md`, every tracked file, 2026-11-15). A hand-written pi configuration goes stale and
sends models formats they refuse.

**What.** When the plan closes:

1. `bun run proxy pi-config` prints a pi `models.json` document that passes pi 1.5.2's schema, one provider
   `ap-<provider>` per available proxy provider, every model on a route it accepts (uc-pi-1, P1–P7).
2. The daemon answers `GET /pi/models.json` (token) with the same document and `GET /.well-known/pi` (open) with the
   token command and the document URL (uc-pi-2, uc-pi-3).
3. `apps/pi-extension` registers every provider when pi starts and refreshes them on pi's model refresh, never stopping
   pi when the proxy is down (uc-pi-4, uc-pi-6).
4. A pi turn works on every provider × api cell, proven with the real pi 1.5.2 binary (uc-pi-5).
5. The reference documents, `README.md`, `AGENTS.md` and `docs/architecture.drawio` describe all of it, and
   `bun run verify` passes at 100 % coverage with a generated granularity report showing zero missing scenarios.
6. The user's own pi (`~/.pi/agent`) loads the extension and lists the `ap-` providers (the original request).

**Out of scope.**

- Recording pi with the recon facility and pi parity replays in `verify` (needs Linux, bubblewrap, mitmproxy; follow-up).
- Translation between formats; changes to pi; new providers; tagging the scenarios of earlier features (the
  granularity report covers only the designs listed in `GRANULARITY_DESIGNS`).
- The Bun pin drift (repository 1.4.2, host 1.4.4): reported, not changed.
- `{repo}/docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md` (untracked), the modified
  `{repo}/docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`, and the existing directory `{repo}/worktrees/baseline-b0eea06`
  with the logs beside it: left untouched.
- Pushing or releasing: step 9.4 asks the user.

**Requirements checked before starting** (planning session, 2026-11-15):

| Requirement | Command | Result |
|---|---|---|
| pi installed | `pi --version` | `1.5.2` |
| Bun | `bun --version` | `1.4.4` |
| Daemon up, every provider | `curl -s http://127.0.0.1:4141/health` | `{"status":"ok","providers":[7 providers]}` |
| Token file shape | `jq -r 'keys' {repo}/.cache/token.json` | `["token"]` (value never printed) |
| pi schema pinned | `shasum -a 256` installed copy and `https://pi.dev/schemas/models.schema.json` | both `3e4cb196…bdc` |
| Branch state | `git -C {repo} rev-parse main`; `git -C {repo} status --short` | `0fd623a…`; two unrelated entries (out of scope) |
| `worktrees/` ignored | `{repo}/.gitignore` line 15 | `worktrees/` |
| No `{worktree}` yet | `ls {repo}/worktrees` | `baseline-b0eea06` and logs only |

**Use cases in scope.**

| Feature | Use case | Component scenario | e2e scenario | Live suites (dependency → use case) |
|---|---|---|---|---|
| `pi-config` | uc-pi-1 | `apps/proxy/tests/component/pi-config.test.ts` `[feature=pi-config use-case=uc-pi-1 tier=component polarity=±]` | `apps/proxy/tests/e2e/pi-config.test.ts` | none (no external dependency) |
| `pi-config` | uc-pi-2 | same file, uc-pi-2 | same file | none |
| `pi-config` | uc-pi-3 | same file, uc-pi-3 | same file | none |
| `pi-extension` | uc-pi-4 | `apps/pi-extension/tests/component/register-providers.test.ts` | `apps/pi-extension/tests/e2e/extension.test.ts` | `pi` → `apps/pi-extension/tests/live/pi-binary.test.ts` |
| `pi-extension` | uc-pi-6 | same file, uc-pi-6 | same file | `pi` → same file |
| `pi-inference` | uc-pi-5 | `packages/dialect-pi/tests/component/pi-catalog.test.ts` | `apps/proxy/tests/e2e/pi-routing.test.ts` | `pi` → `pi-binary.test.ts`; `claude`, `antigravity`, `openai`, `openrouter`, `opencode`, `opencode-go`, `cheaper-inference` → `apps/pi-extension/tests/live/pi-<provider>.test.ts` |

Every scenario name carries the tag `[feature=<f> use-case=<uc> tier=<unit|component|e2e|live> polarity=<positive|negative>]`
(one test per polarity); `scripts/gate/granularity-report.ts` counts them (step 7.1).

**Open questions.** none. The four scope questions were answered on 2026-11-15 (`{record}` § Decisions). Every pi
behaviour the rules rely on was read from pi 1.5.2's own code and, where marked "run", executed with `node -e` against
pi's modules (planning record § Evidence gathered). What is inferred and still unproven on the wire is proven by the
live tier (stage 8): pi's loading of `apps/pi-extension` through jiti 2.7.0 with workspace-alias imports (resolution
was run, loading by the real binary was not), and whether `pi update --models` calls an extension's `refreshModels`
(step 8.3, gate 3; its `problems` table holds the handling).

## Amendment 5 (approved 2026-11-18; amendment file SHA-256
  `44f6b64434ec29d1f1c8e0fce920ff2e927e0ef6691a0685e6734f811e13b062`; base plan verified unchanged at
  `cd01c12f435bb078a2fbda356a2afac89ed4c7d34744583232b3744e4453e8fc`)

Status on 2026-11-18 09:56: stages 0-7 green and committed (last stage commit `b091aef`); step 8.1r recorded
BLOCKED with 24 pass / 15 fail in `e184f84`; the worktree held 2 modified docs and 2 untracked paths. Stage 8A is
new work; `8.0r` and `8.0s` run before it; the order is stated in section 7.

### 1. State reconciliation — what the plan's text no longer matches

| # | The plan says | Real state on 2026-11-18 | Evidence | What A5 does |
|---|---|---|---|---|
| S1 | `{logs}` = `/private/var/folders/_m/jyv5nmsn4y305mjjcm_4fq240000gn/T/opencode/2026-11-15-23-52-pi-compatibility`, created at 0.5, deleted at 9.6 | it does not exist | `ls -d "$TMPDIR"/opencode/2026-11-15*` → nothing; `find /var/folders/_m -maxdepth 5 -name '*pi-compatibility*'` → nothing | 8.0r recreates it at the same path and rebuilds the guard, the marker and the before-listing |
| S2 | the 4.8a residue marker and before-listing exist in `{logs}` | lost with the directory | S1 | 8.0r records the loss with the S1 commands and takes a fresh marker + before-listing; the 4.8 residue is carried in `{record}` § 4.8a as already written |
| S3 | step 8.2/8.5 name the user's daemon as pid 96176 | the user's daemon is pid 35662 | `lsof -nP -iTCP:4141 -sTCP:LISTEN` (2026-11-18) | every gate that names a pid discovers it at run time (`lsof -tTCP:4141 -sTCP:LISTEN`), never hard-codes 96176 |
| S4 | the disposable daemon was stopped at 8.5r | a disposable daemon from 2026-11-16 is still alive: pid 75452, listening on :4142, cwd `{worktree}` | `lsof -nP -iTCP:4142 -sTCP:LISTEN`; `lsof -p 75452 -a -d cwd -Fn` | new step 8.0s stops it and proves the port and the pid are free |
| S5 | step 8.0 and steps 8.2, 8.4, 8.5, 9.5 run as written | superseded by 8.0r, 8.2r, 8.4r, 8.5r, 9.5r (A2, A5) | plan § A2 | unchanged; A5 only adds 8.0r and 8.0s before them |
| S6 | `bun install --frozen-lockfile` is needed in `{repo}` after the merge (A2 gap 2) | still pending; `{repo}` has no `node_modules` for the new workspaces | A2 text | 9.4r runs it as a gate |

No path, placeholder, branch, base commit or stage number changes. `{base}` stays `0fd623a884de8576ab95bfae9f937eadbb4f17b2`.

---

### 2. The antigravity tool-call id gap — root cause proven

### 2.1 Known

1. The failing cell is `antigravity x google-generative-ai` (pi's Gemini API client) against
   `antigravity/claude-opus-5-5-high` and `antigravity/claude-opus-5-5-low`. The upstream answers HTTP 400
   `{"error":{"code":400,"message":"{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.1.content.0.tool_use.id: Field required\"},\"request_id\":\"req_vrtx_...\"}","status":"INVALID_ARGUMENT"}`
   on every tool turn, at caps 128 and 256, on both models (`{record}` § Step 8.3 E1 findings, item 4;
   `docs/issues/2026-11-16-20-47-antigravity-tool-use-id-gap.md`).
2. pi 1.5.2 omits the id itself, by design, for a provider-prefixed model id:
   `pi-ai/dist/api/google-shared.js:125` `requiresToolCallId(modelId)` returns `true` only for `claude-*`,
   `gpt-oss-*` and Gemini 3+; `:235` writes `...(requiresToolCallId(model.id) ? { id: block.id } : {})` into
   `functionCall`, and `:270` does the same for `functionResponse`. pi passes `model.id` = the pi model id
   (`antigravity/claude-opus-5-5-high`), which starts with none of those prefixes.
   Probe (2026-11-18): `requiresToolCallId("antigravity/claude-opus-5-5-high")` → `false`;
   `requiresToolCallId("claude-opus-5-5-high")` → `true`.
3. The real antigravity client (1.107.0) does send ids, and they are opaque strings of the shape `call_<32 hex>`:
   `tests/fixtures/captures/p0-live/e3/t4-f3a-tool-choice-auto.json` carries
   `functionCall: {"name": "get_time", "args": {...}, "id": "call_7f6c7a16ca5f4035a8d18358"}`, and the cell's
   `signCalls` reads that optional id today (`native-gemini.ts:170-172`). The shape is opaque to the upstream, so the
   law does not copy it (K14).
4. No `tool_use` construction exists anywhere under `packages/provider-antigravity/src/`, and
   `signCalls` returns unchanged for a non-Gemini target (`native-gemini.ts:163`).

### 2.2 Inferred, from 2.1

Claude-on-Vertex maps a Gemini `functionCall` part onto Anthropic `tool_use` and requires its `id`; it maps
`functionResponse` onto `tool_result` and requires the matching `tool_use_id`. The request that failed carried
`messages.1` = the second turn (the tool loop), which is exactly where a call and its response travel. So the
conversion must synthesize an id per call and re-use it on the matching response.

### 2.3 Not known, and how it is closed

- Whether the upstream also requires `functionResponse.id` to equal the call's. Closed by 8A.7: the live tool turn
  either goes green (both ids needed and correct) or stays 400 (then E1 with the new body).
- Whether an id-less call on a *Gemini* target must also get one. Not needed: Gemini tool turns pass today
  (`{record}` section Live: the Gemini tool turns are green);
  the law is therefore restricted to non-Gemini targets (regress zero).

### 2.4 Why the fix belongs to this plan

The user's directive is to finish the pi integration for agy, claude and codex/openai, and the agy tool turn is the
one deterministic failure a code change can close (the other ten are account state: openai re-login, opencode-go
subscription, quota). Filing it as a separate plan would leave stage 8 unable to go green, and the granularity
report red. So it is a new stage of this plan, with its own design node, scenarios and tiers.

---

### 3. Change C1 — `idCalls` in `{worktree}/packages/provider-antigravity/src/domain/native-gemini.ts`

Insert after `signCalls` (which ends at the `}` before `checkSystem`, line ~193), and call it in
`prepareGeminiRequest` directly after the existing `contents = signCalls(...)` line:

```ts
contents = signCalls(contents, model.wireId, options.signatures, dropped);
contents = idCalls(contents, model.wireId); // new
```

The function, in the file's own style (private, early return, `map` over contents):

```ts
/** Non-Gemini targets (Claude, gpt-oss) need a tool-call id: give every id-less call one, and its response the same id. */
function idCalls(contents: GeminiContent[], modelWireId: string): GeminiContent[] {
  if (isGeminiFamily(modelWireId)) return contents;
  const used = new Set<string>();
  for (const c of contents) for (const part of c.parts) {
    const call = part["functionCall"] as Record<string, unknown> | undefined;
    const response = part["functionResponse"] as Record<string, unknown> | undefined;
    const id = (call?.["id"] ?? response?.["id"]);
    if (typeof id === "string") used.add(id);
  }
  let n = 0;
  const next = (): string => {
    do { n += 1; } while (used.has(`ap_call_${n}`));
    const id = `ap_call_${n}`;
    used.add(id);
    return id;
  };
  const pending: { name: string; id: string }[] = [];
  return contents.map((c) => ({
    role: c.role,
    parts: c.parts.map((part) => {
      const call = part["functionCall"] as Record<string, unknown> | undefined;
      if (call !== undefined) {
        const id = typeof call["id"] === "string" ? (call["id"] as string) : next();
        pending.push({ name: call["name"] as string, id });
        return typeof call["id"] === "string" ? part : { ...part, functionCall: { ...call, id } };
      }
      const response = part["functionResponse"] as Record<string, unknown> | undefined;
      if (response === undefined || typeof response["id"] === "string") return part;
      const at = pending.findIndex((p) => p.name === response["name"]);
      const id = at === -1 ? next() : pending.splice(at, 1)[0]!.id;
      return { ...part, functionResponse: { ...response, id } };
    }),
  }));
}
```

Rules this code carries (each one test in 8A.5):

- **R1** a Gemini target returns unchanged (`isGeminiFamily`), so Gemini cells regress zero.
- **R2** an id the request already carries is never rewritten, on a call or on a response.
- **R3** a synthesized id is `ap_call_<n>`, `n` from 1, deterministic per request, and skips every id the request
  already carries (no collision).
- **R4** a response without an id takes the id of the earliest unpaired call with the same `name` (FIFO), so two
  parallel calls of one tool pair correctly.
- **R5** a response with no preceding call gets a fresh id and is forwarded, never dropped (strict translation: the
  proxy does not silently discard a tool result).
- **R6** no `dropped` entry is added: the header keeps meaning "the proxy removed something".

No new file, port, adapter, config value or dependency: the law sits inside one existing domain function of one
existing cell (KISS, `AGENTS.md` 6.9 — no seam is crossed, and a use case does not require a second implementation).

---

### 4. Change C2 — `AGENTS.md` §3, one new law row (verbatim)

Append after the last Antigravity row of the wire-law table:

```
| Antigravity Gemini cell: on a non-Gemini target every `functionCall` without an `id` gets `ap_call_<n>` (request-scoped, deterministic, never colliding with an id the request carries) and its `functionResponse` the same id, because Claude-on-Vertex requires `tool_use.id` and pi 1.5.2 omits ids for provider-prefixed model ids | pi 1.5.2 `pi-ai/dist/api/google-shared.js:125,235,270`; 400 `messages.1.content.0.tool_use.id: Field required` ([probe](docs/reference/{ts}-antigravity-tool-id-probe.md)) |
```

---

### 5. Change C3 — product design, new use case

In `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md`, under the feature that carries
uc-pi-5, append:

```md
#### uc-pi-7 — A tool loop whose client omits tool-call ids

**Purpose.** A client that speaks Gemini-native `functionCall`/`functionResponse` without ids (pi 1.5.2 with a
provider-prefixed model id) completes a tool loop on a Claude-on-Vertex model through the antigravity cell.

**Contract.** Input: `contents` holding one id-less `functionCall` and one id-less `functionResponse` with the same
`name`. Output: the same contents, every call carrying `ap_call_<n>` and the matching response the same id; a Gemini
target, or an id the client sent, unchanged. Failure modes: none added (no new 400, no new dropped entry).

**Acceptance criteria.** unit positive: call and response paired; unit negative: a response with no call gets a fresh
id and is forwarded; component positive: the cell prepares the loop; component negative: an existing id is preserved;
e2e positive: the replayed upstream receives the paired ids; e2e negative: a Gemini target receives no synthesized id.
```

And in the design's `Dependencies per use case` paragraph, add:

```md
uc-pi-7 — none (proven end-to-end by uc-pi-5's antigravity tool turn, which is the scenario that exposed the law).
```

---

### 6. Change C4 — architecture design

In `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-architecture.md`, in the `provider-antigravity` node,
add one row to its table: `native-gemini.ts · idCalls (private) — synthesizes and pairs tool-call ids on a non-Gemini
target (uc-pi-7) · tests: packages/provider-antigravity/tests/{unit,component}, apps/proxy/tests/e2e/gemini-cell.test.ts`.

---

### 7. New Stage 8A — the antigravity tool-call id law

**Why.** The one deterministic live failure a code change closes (§ 2.4); without it stage 8 cannot go green.

**What.** `{worktree}/docs/reference/{ts}-antigravity-tool-id-probe.md`; the `AGENTS.md` row; the design nodes; the
`idCalls` function; its unit, component and e2e scenarios; a green `apps/proxy/tests/e2e/gemini-cell.test.ts` and a
green `packages/provider-antigravity` tier.

**Enter gate.** Steps 8.0r and 8.0s green, and 8.1r's disposition recorded per A4 (24 pass / 15 fail, every failure categorised).
**Order after A5.** `8.0r` -> `8.0s` -> `8A.1` -> `8A.2` -> `8A.3` -> `8A.4` -> `8A.5` -> `8A.6` -> `8A.7` ->
`8.2r` -> `8.3r` -> `8.4r` -> `8.5r` -> `8.6r` -> stage 9. The document below states 8A first because it is the new
work; the order is the one on this line, and 8.0r/8.0s are in section 8.


#### Step 8A.1 — Reference: the probe

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/docs/reference/{ts}-antigravity-tool-id-probe.md` (`{ts}` = `date +%Y-%m-%d-%H-%M` at the step,
  recorded in `{record}`)
- **content**: title `# Antigravity tool-call ids: the 400 and the law`; sections: the failing request and its 400 body
  (from § 2.1.1, with the request id); pi's source lines `google-shared.js:125,235,270` quoted with the probe output
  of § 2.1.2; the real IDE capture path and the `functionCall.id` it carries; the inferred mapping (§ 2.2); what
  remains unknown (§ 2.3); the law as written in C2. Every claim carries its path and line.
- **depends on**: 8.0r
- **gates**: 1. `grep -c 'google-shared.js:125' {target}` → ≥ 1; 2. `grep -c 'tool_use.id: Field required' {target}` → ≥ 1;
  3. `{bun} scripts/gate/lint-docs.ts` → exit `0`.
- **problems**: lint rejects the name → use the timestamp `date` printed, never an edited one.
- **escalation**: E1
- **failure**: rollback `rm {target}`.
- **returns**: diff, `{ts}`.

#### Step 8A.2 — Law row

- **runs in**: subagent `general` (same, after 8A.1)
- **action**: `edit`
- **target**: `{worktree}/AGENTS.md`
- **content**: the row of § 4, with `{ts}` from 8A.1.
- **depends on**: 8A.1
- **gates**: 1. `grep -c 'ap_call_<n>' {target}` → `1`; 2. `grep -c '{ts}-antigravity-tool-id-probe' {target}` → `1`;
  3. lint → exit `0`.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- AGENTS.md`.
- **returns**: diff.

#### Step 8A.3 — Design nodes

- **runs in**: subagent `general` (same, after 8A.2)
- **action**: `edit`
- **target**: `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md` and
  `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-architecture.md`
- **content**: § 5 verbatim into the product design (use case plus the dependencies line); § 6 into the architecture.
- **depends on**: 8A.2
- **gates**: 1. `grep -c '^#### uc-pi-7' `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md`` → `1`; 2. `grep -c 'uc-pi-7 — none' `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md`` → `1`;
  3. `grep -c 'idCalls' `{worktree}/docs/design/2026-11-15-23-52-pi-compatibility-architecture.md`` → `1`; 4. lint → exit `0`.
- **problems**: the granularity report reads the design's headings → keep the exact heading shapes of § 5.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- docs/design`.
- **returns**: diff.

#### Step 8A.4 — The function and its call site

- **runs in**: subagent `general` (same, after 8A.3)
- **action**: `edit`
- **target**: `{worktree}/packages/provider-antigravity/src/domain/native-gemini.ts`
- **content**: the function and the call site of § 3, with the file's own header comment gaining one line
  `//   - a tool call on a non-Gemini target carries an id (AGENTS.md §3 antigravity tool-id law).`
- **depends on**: 8A.3
- **gates**: 1. `{bun} run typecheck` → exit `0`; 2. `grep -n 'idCalls(contents, model.wireId)' {target}` → one line
  after `signCalls`; 3. `{bun} test packages/provider-antigravity` → exit `0`, or every failure is one `{record}` section Baseline gate
  already lists (compare the two, name each match).
- **problems**: `exactOptionalPropertyTypes` on the spreads → build the new part object explicitly (as the existing
  code does for `functionResponse`), never widen the type.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- packages/provided-antigravity/src/domain/native-gemini.ts`.
- **returns**: diff, gate outputs.

#### Step 8A.5 — Unit scenarios

- **runs in**: subagent `general` (same, after 8A.4)
- **action**: `edit`
- **target**: `{worktree}/packages/provider-antigravity/tests/unit/native-gemini.test.ts`
- **content**: a `describe("tool-call ids")` with one test per rule R1-R6, each tagged `[feature=pi-inference use-case=uc-pi-7 tier=unit polarity=positive]` (R2, R3, R4) or `... polarity=negative` (R1 Gemini target unchanged, R5 orphan response, R6 no dropped entry). The two `ModelDescriptor`s are built from ids the file's existing cases already use, read with `grep -o 'claude-[a-z0-9.-]*' <target> | sort -u` and `grep -o 'gemini-[a-z0-9.-]*' <target> | sort -u`; never an id typed from memory. Drive `prepareGeminiRequest` directly.
- **depends on**: 8A.4
- **gates**: 1. `{bun} test packages/provided-antigravity/tests/unit` → exit `0`; 2. `{bun} test --coverage
  packages/provided-antigravity` on the file → `100.00%` lines and branches for `native-gemini.ts`; 3. the granularity
  the granularity report's `uc-pi-7 | unit | none` row shows `positive` >= 3 and `negative` >= 3.
- **problems**: coverage below 100 % → add the missing branch case, never a waiver.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- packages/provided-antigravity/tests/unit/native-gemini.test.ts`.
- **returns**: diff, gate outputs, the coverage line.

#### Step 8A.6 — Component scenarios

- **runs in**: subagent `general` (same, after 8A.5)
- **action**: `edit`
- **target**: `{worktree}/packages/provider-antigravity/tests/component/adapters.test.ts`
- **content**: two scenarios through the cell's adapter with fakes (no network): positive — an id-less loop on a Claude
  model reaches the adapter's request with `ap_call_1` on both parts; negative — an id the client sent (`toolu_9`)
  survives untouched on both parts. Tags `tier=component polarity=…`.
- **depends on**: 8A.5
- **gates**: 1. `{bun} test packages/provided-antigravity/tests/component` → exit `0`; 2. the report's `uc-pi-7 | component | none` row shows `positive` >= 1 and `negative` >= 1.
- **problems**: the adapter may need a signed-in fake → use the file's existing fakes, never a network call.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- packages/provided-antigravity/tests/component/adapters.test.ts`.
- **returns**: diff, gate outputs.

#### Step 8A.7 — e2e scenarios and the stage gate

- **runs in**: subagent `general` (same, after 8A.6)
- **action**: `edit`
- **target**: `{worktree}/apps/proxy/tests/e2e/gemini-cell.test.ts`
- **content**: two cases in the file's own `call()` harness with `ReplayUpstreams`. Positive: the antigravity Claude id recorded in `{record}` section Live catalog, with an id-less `functionCall` and its `functionResponse` -> the recorded upstream request carries `ap_call_1` on both parts. If the file's scripted `fetchAvailableModels` answer lacks that id, extend that answer with it from the record (evidence, never an invented id). Negative: a Gemini-family id the file already uses, same body -> the recorded request carries no `id` at all. Tags `tier=e2e polarity=...`. Then the stage gate.
- **depends on**: 8A.6
- **gates**: 1. `{bun} test apps/proxy/tests/e2e/gemini-cell.test.ts` (behind the A2 browser guard) → exit `0`;
  2. `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS` with every uc-pi-7 row present;
  3. `{bun} run verify` → no step or test fails that passed in `{record}` § Baseline gate;
  4. commit per rule 10.
- **problems**: the e2e file's scripted catalog lacks the Claude id → extend the scripted answer, recorded; the
  request never reaches a provider.
- **escalation**: E1
- **failure**: stage 8 does not resume; the owning step is reopened.
- **returns**: diff, gate outputs, the recorded upstream request excerpt.

---

### 8. Stage 8, revised

#### Step 8.0r — Recreate the scratch root, the guard and the snapshot

- **runs in**: main session — it writes only to the scratch root, and it is the residue bookkeeping of 3.10
- **action**: `run`
- **target**: `{logs}`
- **content**: `mkdir -p -m 700 {logs}/briefs {logs}/no-browser-bin`; write `{logs}/no-browser-bin/open` (`#!/bin/sh` +
  `exit 0`, mode 755, as A2); write `{logs}/marker` (`date +%Y-%m-%dT%H:%M:%S`); then the before-listing of 3.10 into
  `{logs}/before.txt`: `ls -la "$TMPDIR"`, `ls -la /tmp`, `ls -la ~/.opencode/plan`, `ls -la ~/.pai/agent`, and for
  `{repo}` `git status --porcelain --ignored`, `git worktree list`, `git branch --all`, `git stash list`. Paste the S1
  commands and their empty output into `{record}` § 4.8a as the proof that the original marker and listing are
  unrecoverable.
- **depends on**: none (the worktree is at `e184f85`, with 8.1r's disposition recorded)
  3. `ls -la {logs}/before.txt` → non-empty; 4. `ls -d {logs}/marker` → the file.
- **problems**: `~/.pai/agent` absent → list its parent instead and record it.
- **escalation**: E1
- **failure**: stage 8 does not resume.
- **returns**: n/a

#### Step 8.0s — Stop the stray disposable daemon

- **runs in**: main session — a live process on the user's host
- **action**: `run`
- **target**: pid 75452 on `127.0.0.1:4142`
- **content**: `lsof -nP -iTCP:4142 -sTCP:LISTEN` to confirm the pid and its cwd (`lsof -p 75452 -a -d cwd -Fn` → `{worktree}`),
  then `kill -INT 75452`; wait up to 10 s, then `kill -TERM 75452` if needed; record which signal ended it.
- **depends on**: 8.0r
- **gates**: 1. `lsof -nP -iTCP:4142 -sTCP:LISTEN` → no output; 2. `kill -0 75452` → exit non-zero; 3. the user's daemon
  on :4141 is untouched (`lsof -tTCP:4141 -sTCP:LISTEN` → 35662, and `/healt` ok).
- **problems**: the pid is gone already → record "already ended" and keep the port gate.
- **escalation**: the user
- **failure**: 8.2r does not start (its port scan would skip 4142).
- **returns**: n/a

#### Step 8.1r — unchanged, one note

The file table, the caps and the tags stand as A3/A4 wrote them. The antigravity tool turn stays at cap 128 (the 400
came with the call already produced, so the cap is not the cause) and needs no edit: step 8A.7's law turns it green.

### Steps 8.2r … 8.6r — unchanged, with pid discovery

Every gate that names the user's daemon reads its pid at run time (`lsof -tTCP:4141 -sTCP:LISTEN`) instead of 96176.
8.2r's problems table gains one row: *the stray daemon still holds :4142* → 8.0s was not green; reopen it.

**8.3r expectation table** (replacing "all green"):

| Cell | Expected after A5 | Handling if not |
|---|---|---|
| antigravity claude tool | **green** (the law) | 8A.7 reopens with the new 400 body |
| antigravity plain / thinking / negatives | green (already) | re-run once |
| claude, antigravity-Gemini, openrouter (3 apis), opencode (4 apis), chea per-inference, pi-binary | green (already, or transient) | re-run once, then the cell rule |
| opengate-go x6 | blocked: 403 subscription required | recorded, per user decision 2026-11-16 |
| openai x2 | blocked: 401 `invalid_grant` → the user re-logins (see § 10) | recorded; after the re-login, re-run the file |
| opencode crouton / minimax / beam / gemini-tool | blocked: 410 deprecated, 400 unavailable, 429 quota, quota flake | re-run once; then recorded |

#### Step 8.6r — stage gate

Unchanged, plus: `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS` and `{record}` § Live carries the
per-cell table with the law's row green.

---

### 9. Stage 9, revised

- **9.1** unchanged (final gate, never delegated).
- **9.2** unchanged, with one added check: `git -C {worktree} diff --stat {base}..HEAD` lists
  `docs/reference/{ts}-antigravity-tool-id-probe.md`, `native-gemini.ts`, the two design docs and the three test files
  of 8A.
- **9.4r** (replaces 9.4): after the merge or the pull request, `cd {repo} && {bun} install --frozen-lockfile` → exit `0`,
  and `git -C {repo} status --porcelain` shows only the two pre-existing entries (A2 gap 2 closed).
- **9.5r** unchanged (the disposable daemon on 4142–4149 proves the user's pi before their own daemon is restarted).
- **9.6r** (replaces 9.6): `rm -rf {logs}` (the recreated directory, its marker and its listing), `test ! -e {logs}`,
  `git -C {repo} worktree list` → no worktree of this plan, `git -C {repo} status --short` → the two pre-existing
  entries. The 4.8 residue (48 leaked temp dirs, listed in `{record}` § 4.8a) is deleted by absolute path in this step
  as well, each proven by `test ! -e`.

---

### 10. What the user must do

1. **openai re-login** (closes 2 of the 15 red cells): `bun run proxy login openai` in `{repo}` against their own
   daemon, in their own browser. The agent never handels the credential.
2. **opencode-go**: needs an active OpenCode Go subscription; without it the 6 cells stay recorded blocked (user
   decision 2026-11-16).
3. **The merge choice** at 9.4r (local `main` recommended: it is already 7 commits ahead of `origin/main` and unpushed).
4. **A daemon restart** at 9.5r, once, so `{repo}` serves the merged code.

---

### 11. Out of scope, unchanged

- pi recon parity recording on Linux (no bubblewrap on this Mac).
- `makeHome`'s `open` fake (A1's follow-up).
- Opencode-go, openai and opencode account state.
- The user's `{repo}` daemon is never stopped (A2 stands).

---

### 12. Decisions, with the recommendation

- **K13** The antigravity id law is a stage of this plan, not a separate plan. → *recommended* yes (§ 2.4).
- **K14** The synthesized id format is `ap_call_<n>`, deterministic and collision-checked. → *recommended* (§ 3 R3).
- **K15** The law applies to every non-Gemini target (`claude-*`, `gpt-oss-*`, future ids), not only `claude-*`. →
  *recommended* (it is the upstream's contract, not a model list).
- **K16** uc-pi-7 declares `dependency = none`; the end-to-end proof stays uc-pi-5's antigravity tool turn, so no
  extra live spend. → *recommended*.
- **K17** The live tier's 10 deterministic failures stay recorded blocked; only the openai re-login and the
  antigravity law are pursued. → *recommended* (matches the user's directive).

---

### 13. Gates once A5 lands

1. `{bun} run typecheck` → exit `0`.
2. `{bun} run test` → the 9 R2 baseline failures and nothing else.
3. `{bun} test apps/proxy/tests/e2e/gemini-cell.test.ts` (guarded) → exit `0`.
4. `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS` (uc-pi-7 rows present).
5. `{bun} scripts/gate/lint-docs.ts` → exit `0`.
6. Stage 8.3r re-run → the antigravity tool cell green.
7. `{bun} run verify` (final, 9.1) → no new failure against `{record}` § Baseline gate.

**Delegation map additions.** `8.0r`, `8.0s` — main session (scratch bookkeeping, and a live
process on the user's host). `8A.1` -> `8A.7` — subagent `general`, one subagent in order, write set
`docs/reference/`, `AGENTS.md`, `docs/design/`, `packages/provider-antigravity/**`, `apps/proxy/tests/e2e/gemini-cell.test.ts`.

## Amendment 6 (approved 2026-11-18; amendment file SHA-256
  `e54a6453e2ae5d7782a5e8e4705154f778f50bbee63602d2df6b0095b75f2989`; base plan verified unchanged at
  `9cd376583fa252554e7650aa17da2ec987138248b62c5b67dfc47d2053e49565`)

Status on 2026-11-18 11:05: stage 8A steps 8A.1-8A.6 green (evidence in section 1 below, re-run by the main
session); 8A.7 gate 1 was red for the darwin login defect A1 already solved, and section 2 is the clause that
closes it. Stage 8A is the last uncommitted stage.

### 1. What stage 8A has already proven (main session re-ran every gate below)

| Step | Gate | Output, re-run by the main session |
|---|---|---|
| 8A.1 | reference note | `docs/reference/2026-11-18-10-34-antigravity-tool-id-probe.md`, `grep -c 'google-shared.js:125'` → `1`; docs lint `PASS (80 files)` |
| 8A.2 | `AGENTS.md` row | `grep -c 'ap_call_<n>'` → `1`; lint `0` |
| 8A.3 | design nodes | `^#### uc-pi-7` → `1`; `uc-pi-7 — none` → `1`; `idCalls` in the architecture → `1`; lint `0` |
| 8A.4 | `idCalls` | `native-gemini.ts:195` (`function idCalls`), `:370` (`contents = idCalls(contents, model.wireId);`); `bun run typecheck` → exit `0`; `bun test pack…/prov…-antigrav…` → `136 pass / 0 fail / 500 expect()` |
| 8A.5 | unit | `73 pass / 0 fail`; scoped coverage `100% (860/860 statements, 723/723 branches, 176/176 functions, 669/669 lines)`; report row `uc-pi-7 | unit | none | yes | yes` |
| 8A.6 | component | `63 pass / 0 fail`; report row `uc-pi-7 | component | none | yes | yes` |

The e2e scenarios exist and read correctly (`git diff` reviewed: the positive case uses the file's own `claude-sonnet-5-5-low`
id and expects `ap_call_1` on both parts; the negative case uses a signed Gemini call and expects no id).

### 2. Why 8A.7 gate 1 was red, and the one change that closes it

**Known.** `apps/proxy/tests/e2e/gemini-cell.test.ts:16` calls `startSignedInDaemon(seams)`, which builds the home with
`makeHome` and logs in twice. `makeHome` fakes only `xdg-open` (`tests/support/e2e/proxy-process.ts:144-153`), while
`apps/proxy/src/adapters/outbound/browser-launcher.ts:15` spawns `open` on darwin. With A2's global guard on `PATH`, that
`open` exits `0`, so no browser ever opens and the daemon never receives a callback → `no browser callback within 30 s`
before any test runs.

**Precedent, already approved and green.** A1 fixed exactly this in `apps/proxy/tests/e2e/pi-routing.test.ts:40-45`:
`makeHome(...)`, then `writeFileSync(join(home.bin, "open"), '#!/bin/sh\nexec "<node>" "<repo>/tests/support/e2e/fake-browser.ts" "$1"\n')`,
then `chmodSync(…, 0o755)`, then the logins and `startDaemon`. That file runs 8 pass / 0 fail. The daemon child's `PATH`
has `home.bin` first, so its fake wins over A2's guard.

**The change.** `8A.7` applies that same block, inline, in `gemini-cell.test.ts`, and drops the
`startSignedInDaemon(seams)` call. No new file, no harness change (the harness fix stays A6's follow-up), write set
unchanged: `apps/proxy/tests/e2e/gemini-cell.test.ts`.

**Fallback, if the login still fails.** Stop and E1 with the daemon's log tail; do not widen the write set.

### 3. The design `;` that 8A.3 had to fix, recorded

8A.3 appended `uc-pi-7 — none (…)` after the `uc-pi-5 → …` sentence, which ended in `.`; the granularity report splits
the paragraph on `;`, so uc-pi-5's list collapsed to `["none"]` and 26 rows turned “unknown dependency”
(`GRANULARITY: FAIL (26 missing)`). The fix — end uc-pi-5's clause with `;` — is correct, is in the tree, and the
report is `PASS (148 scenarios)`. A6 records it so the plan matches the tree; nothing else about 8A.3 changes.

### 4. What changes in the plan

| Step | Change |
|---|---|
| 8A.7 | content gains: "replace the `startSignedInDaemon(…)` call with A1's block at `pi-routing.test.ts:40-45` (home, `open` fake, `chmod 755`), then the two logins and `startDaemon`, as that file does"; gates become 1. `grep -c 'home.bin, "open"' <target>` → `1`; 2. `PATH={logs}/no-browser-bin:$PATH bun test <target>` → exit `0`; 3. granularity report → `PASS` with the uc-pi-7 e2e row `yes/yes`; 4. `bun run verify` → no new failure against `{record}` § Baseline gate; 5. commit per rule 10 |
| 8A.3 | no change; A6 only records the `;` that was already applied |
| 9.1 | gate 1 adds: `bun test apps/proxy/tests/e2e/gemini-cell.test.ts` (guarded) → exit `0` |

### 5. Out of scope, unchanged

A6's follow-up (`makeHome` faking `open` on darwin for every e2e file) stays out of this plan; it is recorded here so the
next e2e author does not rediscover it.

## Delegation map

| Step | Runs in | Why it can run there | Write set | Returns |
|---|---|---|---|---|
| 0.1 | subagent `general` | one git command, verified by gate | `{worktree}` (new) | command output, `git worktree list` |
| 0.2 | subagent `general` | file moves + one commit inside the worktree | the four planning documents | `git show --stat HEAD` |
| 0.3 | subagent `general` | locked install inside the worktree | `{worktree}/node_modules` (ignored) | install output, versions, `git status` |
| 0.4 | main session | exemption decision about live credentials (`AGENTS.md` 4.7, secrets) | `{record}` | n/a |
| 0.5 | main session | uses the proxy token (secrets, `AGENTS.md` 4.7) | `{logs}/catalog.json` | n/a |
| 0.6 | main session | baseline gate is never delegated | `{record}` | n/a |
| 0.7, 1.3, 2.5, 3.5, 4.9, 5.9, 6.7, 7.3, 8.6 | main session | stage gates are never delegated | `{record}` | n/a |
| 1.1, 1.2 | subagent `general` (parallel) | disjoint files | `scripts/evidence/fetch-specs.ts`, `docs/reference/specs/*` / `tests/support/json-schema.ts` + test | diff + gate output |
| 2.1 \u2192 2.2 \u2192 2.3 \u2192 2.4 | subagent `general` (one subagent, in order) | each edits files the next one reads | `packages/core`, `packages/dialect-opencode/src`, `apps/proxy/src` (rename only) | diff + gate output |
| 3.1 \u2192 3.4 | subagent `general` (in order) | one workspace | `packages/dialect-pi/**`, `apps/proxy/package.json`, `tests/arch/architecture.test.ts`, `bun.lock` | diff + gate output |
| 4.1 \u2192 4.8 | subagent `general` (in order) | one app, shared files | `apps/proxy/**`, `docs/reference/2026-10-17-19-26-proxy-api.md`, `docs/reference/2026-10-17-19-26-proxy-openapi.json` | diff + gate output |
| 5.1 \u2192 5.8 | subagent `general` (in order) | one workspace | `apps/pi-extension/**`, `tests/arch/*`, `bun.lock` | diff + gate output |
| 6.1 \u2192 6.6 | subagent `general` (in order) | documents only | `docs/**` (this plan excluded), `README.md`, `AGENTS.md` | diff + gate output |
| 7.1, 7.2 | subagent `general` | tooling | `scripts/gate/*`, `scripts/tests/unit/*` | diff + gate output |
| 8.1 | subagent `general` | test files only | `apps/pi-extension/tests/live/*` | diff + typecheck output |
| 8.2, 8.3, 8.4, 8.5 | main session | touch the user's running daemon and real accounts (live state, `AGENTS.md` 4.7) | none in git | n/a |
| 9.1–9.6 | main session | final gate, plan loop, record, integration question, the user's own pi configuration, cleanup | `{record}`, `~/.pi/agent/settings.json` (9.5), `{logs}` (9.6) | n/a |

Stages 3 and 5 are independent once stage 2 is green, but both edit `bun.lock` and `tests/arch/architecture.test.ts`,
so they run in order, never in parallel.

## Rules of execution

1. Stages run in order; a stage starts only when the previous stage gate is green.
2. Inside a stage, a step starts only when every step in its `depends on` is green.
3. Every step is delegated unless its `runs in` says `main session` with its reason; every ready delegation is
   launched at once.
4. A brief is a step: action, target, content, depends on, gates, problems, escalation, failure, returns, plus the
   boundaries **B1**: write only the step's target and the files its content names, inside `{worktree}` (scratch
   scripts and outputs may go to `{logs}`); never touch
   `{repo}` outside `worktrees/`, `~/.pi`, `{repo}/.cache`, or any other repository; never commit (except step 0.2
   and the commits of rule 10), push, release, or install anything globally; report a gap instead of filling it.
5. A gate is binary; its command runs, its expected result is observed, its output is pasted into `{record}` under the
   step id. No gate is skipped, relaxed or reinterpreted.
6. A failed gate goes to `problems`; when no row matches, `escalation` applies.
7. No gate output, no done.
8. Any change to this plan is written here first by the `plan` agent and re-approved by SHA-256.
9. The loops below run at every level; two consecutive clean passes close a loop.
10. Each stage closes with one commit in `{worktree}` made by the main session after the stage gate is green:
    `git -C {worktree} add -A && git -C {worktree} commit -m "<stage title> (plan 2026-11-15-23-52)"`, and the gate
    `git -C {worktree} status --porcelain` → empty.
11. Every command runs from `{worktree}` (`cd /Users/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-pi-compatibility`)
    unless the step names another directory. `bun` is `{bun}`.
12. **E1 (default escalation).** When a gate fails and no `problems` row matches, or a row's handling fails: a
    subagent returns the exact command, its output and the smallest question to the main session; the main session
    asks the `plan` agent when the fix changes this plan, and the user (with the `question` tool, options and a
    recommended option) when it changes scope, cost, data, credentials or an irreversible action. With no answer the
    step stops, the plan stays at the last green step, and it is reported blocked. Never guess, never substitute.
13. **Evidence.** Every step's gate output goes to `{record}` § `Step <id>`.
14. **Tags.** Every new test name ends with `[feature=<f> use-case=<uc> tier=<tier> polarity=<positive|negative>]`;
    live tests add `dependency=<d>` before `polarity` (unit tests: `use-case=` the use case the unit serves).
15. **Placeholders in gates.** `{target}` in a gate is that step's `target` path; `{id}` in a URL template is the
    model's `id` from the served document; `%{http_code}` is `curl`'s own format variable.

## The loops

- **Step loop.** Plan: every field of the step against `AGENTS.md` 3.4; each gate proves exactly this step. Build:
  execute, review the artifact against `target`, `content`, `returns`, re-run every gate, rebuild on any difference,
  repeat until a full pass shows none.
- **Stage loop.** Plan: the stage `what` is covered by its steps and nothing else, the order has no inversion, the
  stage gate proves the whole `what`. Build: after the last step every artifact is present, the stage gate is green;
  reopen the step that should have produced any missing artifact.
- **Plan loop.** Plan: the inventory, the use-case table, the delegation map and the final gate against the request
  and the design trees; no step depends on a later one. Build: step 9.2.

Each pass corrects only what it found; a refinement never relaxes a gate, reorders a stage or widens scope.

## Stage 0 — Worktree, environment, baseline

**Why.** `AGENTS.md` 7.1–7.8: no work on `main`; the baseline separates pre-existing failures from regressions. The e2e
tier has never been run on macOS (committed runs carry `/home/mavasbel/...` paths; `apps/proxy/tests/e2e/cli.test.ts:29-47`
reads `/proc`), so the macOS baseline is evidence this plan needs.

**What.** `{worktree}` on branch `feat-pi-compatibility` at `{base}`; the planning documents committed in it; its
dependencies installed; the baseline gate output in `{record}`.

**Enter gate.** `git -C {repo} rev-parse main` → `0fd623a884de8576ab95bfae9f937eadbb4f17b2`, and
`shasum -a 256 {repo}/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md` → `{plan_sha256}` from the approval.

### Step 0.1 — Create the worktree

- **runs in**: subagent `general`
- **action**: `run`
- **target**: `{worktree}`
- **content**: `git -C /Users/mavasbel/Dev/repos/devtools/accounts-proxy worktree add -b feat-pi-compatibility /Users/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-pi-compatibility main`
  (no `git fetch` into `main`: local `main` is ahead of `origin/main`, see header).
- **depends on**: none
- **gates**:
  1. `git -C {repo} worktree list` → a line `…/worktrees/feat-pi-compatibility  0fd623a [feat-pi-compatibility]`
  2. `git -C {worktree} rev-parse HEAD` → `0fd623a884de8576ab95bfae9f937eadbb4f17b2`
  3. `git -C {repo} status --short` → exactly the two pre-existing entries (` M docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`,
     `?? docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md`) plus this plan's four untracked files
     (`docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`, `docs/design/2026-11-15-23-52-pi-compatibility-{product,architecture}.md`,
     `docs/sessions/ses_e1d2bb206ffeA1ncekZZy0G4WO.md`)
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | `fatal: a branch named 'feat-pi-compatibility' already exists` | earlier attempt | stop; E1 to the user with `git -C {repo} log -1 feat-pi-compatibility` (never delete it unasked) |
  | `already exists` for the path | leftover directory | stop; E1 with `ls -la {worktree}` |

- **escalation**: E1
- **failure**: nothing else starts; rollback `git -C {repo} worktree remove {worktree} && git -C {repo} branch -D feat-pi-compatibility` (only after the user confirms).
- **returns**: the command output and the three gate outputs.

### Step 0.2 — Move the planning documents into the worktree and commit them

- **runs in**: subagent `general`
- **action**: `move`
- **target**: the four files listed in gate 0.1.3, from `{repo}/<path>` to `{worktree}/<path>`
- **content**: `mv` each file to the same relative path under `{worktree}`; then
  `git -C {worktree} add docs/plans/2026-11-15-23-52-pi-compatibility-plan.md docs/design/2026-11-15-23-52-pi-compatibility-product.md docs/design/2026-11-15-23-52-pi-compatibility-architecture.md docs/sessions/ses_e1d2bb206ffeA1ncekZZy0G4WO.md && git -C {worktree} commit -m "docs: pi compatibility plan and design (plan 2026-11-15-23-52)"`.
  The executing session then creates `{record}` (its own id) with a link to the planning record.
- **depends on**: 0.1
- **gates**:
  1. `shasum -a 256 {worktree}/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md` → `{plan_sha256}`
  2. `git -C {repo} status --short` → exactly the two pre-existing entries
  3. `git -C {worktree} show --stat --format=%s HEAD` → the four files, subject as above
  4. `{bun} scripts/gate/lint-docs.ts` → exit `0` (dated names, links)
- **problems**: gate 4 reports a broken link in the new documents → fix the link in the same step (documents only), re-run.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} reset --hard {base}` after moving the files back.
- **returns**: gate outputs.

### Step 0.3 — Prepare the environment

- **runs in**: subagent `general`
- **action**: `run`
- **target**: `{worktree}`
- **content**: the repository declares no `bootstrap`/`setup` target (`README.md:39`: `bun install`); lockfile `bun.lock`
  → `{bun} install --frozen-lockfile` inside `{worktree}`, after `{bun} install --help` confirms the flag.
- **depends on**: 0.2
- **gates**:
  1. `{bun} install --help` → lists `--frozen-lockfile`
  2. `{bun} install --frozen-lockfile` → exit `0`
  3. `{bun} --version`; `{pi} --version` → `1.4.4`; `1.5.2` (pasted; drift against the 1.4.2 pin recorded, not changed)
  4. `git -C {worktree} status --porcelain` → empty
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | `lockfile had changes, but lockfile is frozen` | manifests and lock disagree at `{base}`, or Bun 1.4.4 rewrites the 1.4.2 lock format | record as a pre-existing finding; E1 to the user (options: install Bun 1.4.2 with `curl -fsSL https://bun.sh/install \| bash -s bun-v1.4.2` (host change, user runs it) / accept a lock rewrite as its own step); never drop the flag silently |
  | `Could not resolve host` | no network | blocked; E1 |

- **escalation**: E1
- **failure**: no test can run; rollback `rm -rf {worktree}/node_modules {worktree}/*/*/node_modules` (ignored paths only).
- **returns**: install output, versions, status.

### Step 0.4 — Environment files and credentials (exemption)

- **runs in**: main session — secrets handling (`AGENTS.md` 4.7)
- **action**: `review`
- **target**: `{repo}/.cache/` (read-only: names and modes, never contents)
- **content**: unit, component and e2e tiers are hermetic (`AGENTS.md` §5 of the repository: replay upstreams, temporary
  homes); they read no untracked file. The live tier (stage 8) needs the real accounts in `{repo}/.cache/accounts.json`.
  Copying it into `{worktree}` is forbidden: `claude` and `openai` refresh tokens are single-use, so two copies sign
  one proxy out (`README.md:60-61`). Exemption: nothing is copied; stage 8 runs the worktree daemon with
  `ACCOUNTS_PROXY_HOME=/Users/mavasbel/Dev/repos/devtools/accounts-proxy/.cache` while the user's daemon is stopped, so
  exactly one process uses the accounts.
- **depends on**: 0.3
- **gates**:
  1. `stat -f '%Sp %N' {repo}/.cache {repo}/.cache/accounts.json {repo}/.cache/token.json` → `drwx------`, `-rw-------`, `-rw-------`
  2. `test ! -e {worktree}/.cache` → exit `0`
  3. `shasum -a 256 {repo}/.cache/proxy.yaml` and `jq -c 'keys' {repo}/.cache/accounts.json` (top-level keys only) →
     pasted; step 8.4 compares against them
- **problems**: modes wider than shown → report to the user (E1); never chmod the user's data unasked.
- **escalation**: E1
- **failure**: stage 8 cannot run; earlier stages are unaffected.
- **returns**: n/a

### Step 0.5 — Snapshot the live catalog

- **runs in**: main session — the proxy token is read here and never handed to a subagent
- **action**: `run`
- **target**: `GET http://127.0.0.1:4141/proxy/v1/models` (the user's running daemon, read-only)
- **content**: `mkdir -p -m 700 {logs} && curl -s -m 30 -H "authorization: Bearer $(jq -r .token {repo}/.cache/token.json)" http://127.0.0.1:4141/proxy/v1/models > {logs}/catalog.json`
  (the token is expanded inside the command and never printed). The file is the real input of gate 2.3.1 and of the
  fixtures of steps 3.2–3.3; it holds model metadata only, no credential.
- **depends on**: 0.4
- **gates**:
  1. `jq '[.catalogs[].models | length] | add' {logs}/catalog.json` → a positive integer (994 on 2026-11-15), pasted
  2. `grep -c -E 'sk-|Bearer|refresh' {logs}/catalog.json` → `0`
- **problems**: `curl` exit 7 → the daemon is not running; ask the user to start it (`bun run proxy serve` in `{repo}`), never start it from the plan.
- **escalation**: E1
- **failure**: gate 2.3.1 and the fixtures have no input; rollback `rm {logs}/catalog.json`.
- **returns**: n/a

### Step 0.6 — Record the baseline gate

- **runs in**: main session — the baseline is never delegated
- **action**: `run`
- **target**: `{worktree}`
- **content**: `cd {worktree} && {bun} run verify > {logs}/baseline-verify.log 2>&1; echo "exit=$?"` (the summary goes
  into `{record}`; the log stays outside the repository).
- **depends on**: 0.5
- **gates**:
  1. the command runs to its `GATE:` line → the line (`PASS`, `FAIL` or `INCOMPLETE`), the exit code and every failing
     step name are pasted into `{record}` § Baseline gate
  2. a failing step in the baseline → listed as pre-existing with its output; never repaired by this plan
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | e2e or recon-parity failures naming `/proc` | macOS host (first macOS run) | pre-existing; record; the final gate compares against exactly this list |
  | typecheck or unit failures | Bun 1.4.4 vs pinned 1.4.2 | pre-existing; record; E1 to the user (options: continue comparing against the baseline (recommended) / install Bun 1.4.2 first) |

- **escalation**: the user, with the failing output, when the baseline is not `PASS`, before stage 1 starts
- **failure**: the plan stops before any change (cheapest exit).
- **returns**: n/a

### Step 0.7 — Stage 0 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: commit `{record}` per rule 10 (subject `Stage 0: worktree, environment, baseline (plan 2026-11-15-23-52)`),
  then `git -C {worktree} log --oneline -3 && git -C {worktree} status --porcelain`
- **depends on**: 0.1–0.6
- **gates**:
  1. → the stage commit and the docs commit on top of `0fd623a`; empty status
  2. `{record}` § Baseline gate → present with the `GATE:` line
- **problems**: any other entry → reopen the step that wrote it.
- **escalation**: E1
- **failure**: stage 1 does not start.
- **returns**: n/a

## Stage 1 — pi's schema and the schema checker

**Why.** P7 requires the document to pass pi 1.5.2's published schema; the repository pins every external spec through
`scripts/evidence/fetch-specs.ts` with URL, SHA-256 and date (`docs/reference/specs/manifest.json`). The test checker
`tests/support/json-schema.ts` throws on any keyword it does not know (lines 1-8), and pi's schema uses eight it lacks:
`$comment`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `minLength`, `maxItems`, `patternProperties` (keyword
census of the schema, 2026-11-15).

**What.** `{worktree}/docs/reference/specs/pi-models-schema.json` with its manifest entry;
`{worktree}/tests/support/json-schema.ts` supporting the eight keywords, with tests.

**Enter gate.** Stage 0 gate green.

### Step 1.1 — Pin pi's schema

- **runs in**: subagent `general`
- **action**: `edit`
- **target**: `{worktree}/scripts/evidence/fetch-specs.ts`
- **content**: after the `opencode-config-schema.json` entry (line 75) insert
  `  // Plan 2026-11-15-23-52 (pi compatibility): pi 1.5.2's models.json schema (rule P7).`
  `  { file: "pi-models-schema.json", url: "https://pi.dev/schemas/models.schema.json" },`
  then run `{bun} scripts/evidence/fetch-specs.ts --only=pi-models-schema.json`.
- **depends on**: stage 0
- **gates**:
  1. `shasum -a 256 docs/reference/specs/pi-models-schema.json` → `3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc`
  2. `cmp -s docs/reference/specs/pi-models-schema.json /opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent/schemas/models.schema.json` → exit `0`
  3. `jq -e '.[] | select(.file=="pi-models-schema.json") | .sha256=="3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc" and .status==200' docs/reference/specs/manifest.json` → `true`
  4. `git -C {worktree} diff --stat` → only `fetch-specs.ts`, `manifest.json` (one entry added, others unchanged), the new schema file
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | gate 1 differs | pi.dev published a newer schema | stop; E1 to the user: pin to the installed 1.5.2 copy (recommended) or upgrade pi first |
  | other manifest entries change | `--only` not honoured | revert `manifest.json`, re-run with `--only` |

- **escalation**: E1
- **failure**: P7 cannot be tested; rollback `git -C {worktree} checkout -- scripts/evidence/fetch-specs.ts docs/reference/specs/manifest.json && rm docs/reference/specs/pi-models-schema.json`.
- **returns**: diff, gate outputs.

### Step 1.2 — Teach the schema checker pi's keywords

- **runs in**: subagent `general`
- **action**: `edit`
- **target**: `{worktree}/tests/support/json-schema.ts`
- **content**: add to `KNOWN` and implement, with JSON Schema 2020-12 semantics: `$comment` (ignored annotation),
  `const` (deep equality), `minimum`, `maximum`, `exclusiveMinimum` (numbers only), `minLength` (strings, code points),
  `maxItems` (arrays), `patternProperties` (each property whose name matches the regex is checked against that schema;
  `additionalProperties` then applies only to properties matched by neither `properties` nor `patternProperties`).
  Update the header comment to name pi's schema. Add one positive and one negative test per keyword to the checker's
  existing test file (the file that imports `validate` under `tests/support/`; the subagent names it in `returns`).
- **depends on**: stage 0
- **gates**:
  1. `{bun} test tests/support` → exit `0`, the 16 new tests listed passing
  2. `{bun} -e 'import {validate} from "@accounts-proxy/test-support/json-schema.ts"; const s=JSON.parse(await Bun.file("docs/reference/specs/pi-models-schema.json").text()); console.log(JSON.stringify(validate(s,{providers:{}})))'` → `[]` (after 1.1)
  3. same with `{providers:{x:{models:[{}]}}}` → a non-empty error list naming `id`
  4. `{bun} run coverage` → the coverage gate line unchanged from the baseline (tests/support is run, not coverage-gated)
- **problems**: an unsupported keyword error on another pinned schema (opencode, OpenAPI) → the new code broke an existing path; fix before continuing.
- **escalation**: E1
- **failure**: P7 tests cannot run; rollback `git -C {worktree} checkout -- tests/support`.
- **returns**: diff, gate outputs, the test file path.

### Step 1.3 — Stage 1 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run typecheck && {bun} test tests/support tests/arch && {bun} scripts/gate/lint-docs.ts`
- **depends on**: 1.1, 1.2
- **gates**: 1. → exit `0`; 2. gates 1.1.1 and 1.2.2 re-run green; 3. commit per rule 10.
- **problems**: a failure → reopen the step that owns the file.
- **escalation**: E1
- **failure**: stage 2 does not start.
- **returns**: n/a

## Stage 2 — Shared client rules in `packages/core`

**Why.** Rule P2 reuses rule O2 and P1 reuses the opencode provider names, but both live as module-private code in
`packages/dialect-opencode/src/adapters/inbound/opencode-config-codec.ts:20-55` (`PROVIDER_NAMES`, `AISDK_PACKAGE`,
`connection`). A second copy in `dialect-pi` would be duplicated infrastructure; a cross-dialect import would couple two
adapters. The origin type `OpencodeOrigin` (`packages/core/src/ports/inbound/opencode.ts:7-12`) is client-neutral and
used by 8 files.

**What.** `packages/core/src/domain/client-connection.ts` (`AISDK_FORMAT`, `ChosenFormat`, `chooseFormat`,
`PROVIDER_DISPLAY_NAMES`) with `packages/core/tests/unit/client-connection.test.ts`;
`packages/core/src/ports/inbound/client-origin.ts` (`ClientOrigin`); `packages/core/src/ports/inbound/pi.ts`
(`PiConfigPort`); `dialect-opencode` on the shared code with byte-identical output.

**Enter gate.** Stage 1 gate green.

### Step 2.1 — Create the shared format choice and provider names

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/packages/core/src/domain/client-connection.ts`
- **content**: header comment `// Rules O2 and P2 (docs/reference/2026-10-16-01-38-model-catalog-rules.md, pi rules): the
  format a client uses for a model, and the provider display names every client configuration shows.`; then:
  `AISDK_FORMAT: Readonly<Record<string, WireFormat>>` = `{"@ai-sdk/anthropic": "anthropic-messages", "@ai-sdk/openai":
  "openai-responses", "@ai-sdk/openai-compatible": "openai-chat", "@ai-sdk/google": "gemini",
  "@openrouter/ai-sdk-provider": "openai-chat"}`; `type ChosenFormat = { readonly format: WireFormat; readonly
  aiSdkPackage?: string }`; `chooseFormat(model: DetailedModel): ChosenFormat | undefined` — when
  `model.aiSdkPackage` is in `AISDK_FORMAT` and `model.formats` includes its format, `{format, aiSdkPackage}`; else
  `{format: model.formats[0]}` when there is one; else `undefined`; `PROVIDER_DISPLAY_NAMES` = the 7 entries of
  `PROVIDER_NAMES` at `{base}` copied verbatim. Imports only `@accounts-proxy/core/domain/*.ts` (domain law). Unit
  tests in `packages/core/tests/unit/client-connection.test.ts`: reference package accepted; reference package whose
  format the model lacks (falls back to first format); unknown package; no formats (`undefined`); every
  `AISDK_FORMAT` row; 7 display names. Names end with `[feature=pi-config use-case=uc-pi-1 tier=unit polarity=…]`.
- **depends on**: stage 1
- **gates**:
  1. `{bun} test packages/core/tests/unit/client-connection.test.ts` → exit `0`, every listed test passing
  2. `{bun} run coverage --workspace packages/core` → `unit[packages/core]: scoped coverage PASS (100%, complete)`
  3. `{bun} run test:arch` → exit `0`
- **problems**: `WireFormat` imported from a non-domain path → architecture failure; import it from its domain file (the subagent names it).
- **escalation**: E1
- **failure**: P1/P2 have no shared source; rollback `git -C {worktree} rm -f packages/core/src/domain/client-connection.ts packages/core/tests/unit/client-connection.test.ts`.
- **returns**: diff, gate outputs.

### Step 2.2 — Rename `OpencodeOrigin` to `ClientOrigin`

- **runs in**: subagent `general` (same subagent as 2.1, after it)
- **action**: `move`
- **target**: `{worktree}/packages/core/src/ports/inbound/client-origin.ts`
- **content**: move the type at `packages/core/src/ports/inbound/opencode.ts:6-12` verbatim into `client-origin.ts`
  as `export type ClientOrigin`, doc comment "Where the proxy answers and how a client (opencode, pi) obtains its
  token."; `opencode.ts` imports it and its two signatures take `ClientOrigin`. Update every user found at `{base}`:
  `apps/proxy/src/adapters/inbound/cli/commands/proxy-commands.ts:7,26`, `apps/proxy/src/composition/container.ts:120,616`,
  `apps/proxy/src/adapters/inbound/cli/commands/catalog-commands.ts:4,132`,
  `apps/proxy/src/adapters/inbound/http/route-handler.ts:25,40`,
  `packages/dialect-opencode/src/adapters/inbound/opencode-config-codec.ts:9,117,140`,
  `apps/proxy/tests/unit/cli-commands.test.ts:5,82`.
- **depends on**: 2.1
- **gates**:
  1. `grep -rn "OpencodeOrigin" {worktree}/packages {worktree}/apps {worktree}/tests {worktree}/scripts --include=*.ts` → no output
  2. `{bun} run typecheck` → exit `0`
  3. `{bun} run test` → exit `0`
- **problems**: a user not in the list → typecheck names it; update it and record it in `returns`.
- **escalation**: E1
- **failure**: typecheck red; rollback `git -C {worktree} checkout -- packages apps` and remove `client-origin.ts`.
- **returns**: diff, gate outputs.

### Step 2.3 — Put `dialect-opencode` on the shared code

- **runs in**: subagent `general` (same subagent, after 2.2)
- **action**: `edit`
- **target**: `{worktree}/packages/dialect-opencode/src/adapters/inbound/opencode-config-codec.ts`
- **content**: delete `PROVIDER_NAMES` (lines 20-28) and use `PROVIDER_DISPLAY_NAMES`; replace `AISDK_PACKAGE`
  (lines 39-45) with `AISDK_OPENCODE_PACKAGE: Readonly<Record<string, OpencodePackage>>` (same five keys → the same
  packages) and `connection(model)` with: `const chosen = chooseFormat(model); if (chosen === undefined) return
  undefined; return { format: chosen.format, package: chosen.aiSdkPackage !== undefined ?
  AISDK_OPENCODE_PACKAGE[chosen.aiSdkPackage]! : FORMAT_PACKAGE[chosen.format].package };`. In
  `packages/dialect-opencode/tests/unit/opencode-config-codec.test.ts` change only line 7's import (`PROVIDER_NAMES` →
  `PROVIDER_DISPLAY_NAMES` from `@accounts-proxy/core/domain/client-connection.ts`) and line 96's identifier.
- **depends on**: 2.2
- **gates**:
  1. golden check over the 994 real models: `{logs}/opencode-golden.ts` (written by the subagent outside the
     repository) imports `OpencodeConfigCodec` by absolute path
     (`{worktree}/packages/dialect-opencode/src/adapters/inbound/opencode-config-codec.ts`), reads
     `{logs}/catalog.json` `.catalogs` and prints `JSON.stringify(new OpencodeConfigCodec().config(catalogs, {origin:
     "http://127.0.0.1:4141", tokenCommand: ["token"]}))`. Before the edit: `{bun} {logs}/opencode-golden.ts >
     {logs}/opencode-before.json`; after: `> {logs}/opencode-after.json`; `cmp -s {logs}/opencode-before.json
     {logs}/opencode-after.json` → exit `0`, and `jq '[.providers[].models | length] | add' {logs}/opencode-before.json`
     → a positive integer (pasted)
  2. `git -C {worktree} diff --stat -- packages/dialect-opencode/tests` → one file, 2 lines changed
  3. `{bun} test packages/dialect-opencode` → exit `0` (unit and the 30,000-case variants parity unchanged)
  4. `{bun} run coverage --workspace packages/dialect-opencode` → scoped PASS
- **problems**: gate 1 differs → the refactor changed behaviour; revert the codec and redo; never adjust the expected output.
- **escalation**: E1
- **failure**: opencode configuration may change for users; rollback `git -C {worktree} checkout -- packages/dialect-opencode`.
- **returns**: diff, gate outputs, both scripts' paths.

### Step 2.4 — Create the pi inbound port

- **runs in**: subagent `general` (same subagent, after 2.3)
- **action**: `create`
- **target**: `{worktree}/packages/core/src/ports/inbound/pi.ts`
- **content**: header `// pi's view of the proxy (plan 2026-11-15-23-52, rules P1–P7): its models.json document and the
  /.well-known/pi manifest. The dialect-pi workspace implements it.`; imports `JsonObject`, `DetailedCatalog`,
  `ClientOrigin`; `export abstract class PiConfigPort { abstract config(catalogs: readonly DetailedCatalog[], at:
  ClientOrigin): JsonObject; abstract manifest(at: ClientOrigin): JsonObject; }` with one doc line each.
- **depends on**: 2.3
- **gates**: 1. `{bun} run typecheck` → exit `0`; 2. `{bun} run test:arch` → exit `0`
- **problems**: none foreseen beyond typecheck errors, fixed in place.
- **escalation**: E1
- **failure**: stage 3 cannot compile; rollback `git -C {worktree} rm -f packages/core/src/ports/inbound/pi.ts`.
- **returns**: diff, gate outputs.

### Step 2.5 — Stage 2 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run typecheck && {bun} run test:arch && {bun} run coverage`
- **depends on**: 2.1–2.4
- **gates**: 1. → exit `0`, `unit: coverage gate PASS`; 2. gate 2.3.1 re-run → `cmp` exit `0`; 3. commit per rule 10.
- **problems**: coverage incomplete in `client-connection.ts` → reopen 2.1.
- **escalation**: E1
- **failure**: stage 3 does not start.
- **returns**: n/a

## Stage 3 — `packages/dialect-pi`

**Why.** Rules P1–P7 (product design §4) turn the detailed catalog into pi's document; `AGENTS.md` §2 puts client
codecs in `packages/dialect-*` `adapters/inbound`.

**What.** `{worktree}/packages/dialect-pi/` with `package.json`, `src/adapters/inbound/pi-config-codec.ts`,
`src/adapters/inbound/pi-thinking.ts`, `tests/unit/pi-config-codec.test.ts`, `tests/unit/pi-thinking.test.ts`,
`tests/component/pi-catalog.test.ts`, `tests/live/.gitkeep`, `tests/e2e/.gitkeep`; the workspace declared in
`apps/proxy/package.json`, `tests/arch/architecture.test.ts:207-223` and `bun.lock`.

**Enter gate.** Stage 2 gate green.

### Step 3.1 — Scaffold the workspace

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/packages/dialect-pi/package.json`
- **content**: `{"name": "@accounts-proxy/dialect-pi", "version": "0.1.0", "private": true, "license": "MIT", "type":
  "module", "description": "pi models.json configuration and well-known manifest (inbound adapters).", "exports":
  {"./*": "./src/*"}, "dependencies": {"@accounts-proxy/core": "workspace:*"}, "devDependencies":
  {"@accounts-proxy/test-support": "workspace:*"}}`; empty `tests/live/.gitkeep`, `tests/e2e/.gitkeep`; a row in
  `scripts/gate/scaffold-packages.ts` after `dialect-opencode` (line 22) with the same name, description and
  dependencies; `"@accounts-proxy/dialect-pi": "workspace:*"` in `apps/proxy/package.json` `dependencies` after
  `dialect-opencode`; `"@accounts-proxy/dialect-pi"` in the sorted list at `tests/arch/architecture.test.ts:207-223`;
  then `{bun} install` (lock update, the one non-frozen install of this stage).
- **depends on**: stage 2
- **gates**:
  1. `git -C {worktree} diff --stat -- bun.lock` → only lines naming `dialect-pi`
     (`git -C {worktree} diff -- bun.lock | grep '^[+-][^+-]' | grep -v dialect-pi` → no output)
  2. `{bun} install --frozen-lockfile` → exit `0`
  3. `test -L {worktree}/apps/proxy/node_modules/@accounts-proxy/dialect-pi` → exit `0`
- **problems**: `bun install` rewrites unrelated lock lines (Bun 1.4.4 vs 1.4.2) → stop; E1 to the user with the diff (options: accept the rewrite as a recorded consequence of the host Bun (recommended only if the lines are format-only) / install Bun 1.4.2).
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- bun.lock apps/proxy/package.json tests/arch scripts/gate && rm -rf packages/dialect-pi`.
- **returns**: diff, gate outputs.

### Step 3.2 — Create the thinking rules

- **runs in**: subagent `general` (same subagent, after 3.1)
- **action**: `create`
- **target**: `{worktree}/packages/dialect-pi/src/adapters/inbound/pi-thinking.ts`
- **content**: `export type PiApi = "anthropic-messages" | "openai-completions" | "openai-responses" |
  "google-generative-ai"`; `export function piThinking(model: DetailedModel, api: PiApi): { reasoning: boolean;
  thinkingLevelMap?: JsonObject; compat?: JsonObject }` implementing P4 and the thinking half of P5 exactly as the
  product design states them: `antigravity` → `{reasoning: false}`; `reasoning` = `model.reasoning === true ||
  (model.reasoningOptions ?? []).length > 0`; with an `effort` option: map `minimal`…`max` (strings only for levels
  the option lists; on `google-generative-ai` `xhigh`/`max` always `null`), `off: "none"` only for `openai` provider
  when `none` is listed, `off: null` for `openai` when it is not; `anthropic-messages` with an effort option →
  `compat.forceAdaptiveThinking: true`. Unit tests `tests/unit/pi-thinking.test.ts`, one per branch, with the live
  catalog's real shapes as fixtures (claude-opus-5-5, claude-opus-4-6 without `xhigh`, claude-haiku-4-5-20251001
  budget-only with `reasoning: false`, gemini-3.5-flash-lite on an opencode Gemini route, gpt-5.6-sol with `none`,
  gpt-6.1-sol without `none`, an antigravity effort model, a toggle-only openrouter model, a model with no options),
  tagged `[feature=pi-config use-case=uc-pi-1 tier=unit polarity=…]`; at least one negative per rule (a level the
  catalog does not list is `null`; antigravity effort ignored).
- **depends on**: 3.1
- **gates**:
  1. `{bun} test packages/dialect-pi/tests/unit/pi-thinking.test.ts` → exit `0`
  2. `{bun} run coverage --workspace packages/dialect-pi` → `pi-thinking.ts` 100 % (the scoped run may still fail on
     the codec file not yet written; the per-file line for `pi-thinking.ts` is the gate)
- **problems**: a fixture shape differs from the live catalog → copy the exact record from `{logs}/catalog.json`
  (step 0.5).
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f packages/dialect-pi/src/adapters/inbound/pi-thinking.ts packages/dialect-pi/tests/unit/pi-thinking.test.ts`.
- **returns**: diff, gate outputs.

### Step 3.3 — Create the codec

- **runs in**: subagent `general` (same subagent, after 3.2)
- **action**: `create`
- **target**: `{worktree}/packages/dialect-pi/src/adapters/inbound/pi-config-codec.ts`
- **content**: header citing rules P1–P7 and the product design; exports `PI_CONFIG_PATH = "/pi/models.json"`,
  `PI_SCHEMA_URL = "https://pi.dev/schemas/models.schema.json"`, `TOKEN_VARIABLE = "ACCOUNTS_PROXY_TOKEN"`,
  `piProviderId(provider) => \`ap-${provider}\``, `PI_API` (P2 table: `anthropic-messages` → `{api:
  "anthropic-messages", path: "/anthropic"}`, `openai-chat` → `{api: "openai-completions", path: "/openai/v1"}`,
  `openai-responses` → `{api: "openai-responses", path: "/openai/v1"}`, `gemini` → `{api: "google-generative-ai",
  path: "/gemini/v1beta"}`), `SUBSCRIPTION_COMPAT` (P5: claude and openai objects verbatim from the product design),
  `gatewayCompat(model, api)` (P6, verbatim), `costEntry` (P3), and `class PiConfigCodec extends PiConfigPort` with
  `config` (P1, P3, P7: skip `unavailable` catalogs; models without a chosen format skipped; model order as in the
  catalog; `compat` = merge of thinking compat, subscription compat, gateway compat, omitted when empty) and
  `manifest` (`{auth: {command: [...at.tokenCommand], env: TOKEN_VARIABLE}, config: {url: at.origin +
  PI_CONFIG_PATH}}`). Unit tests `tests/unit/pi-config-codec.test.ts` (fixture style of
  `packages/dialect-opencode/tests/unit/opencode-config-codec.test.ts:11-15`): the document validates against
  `docs/reference/specs/pi-models-schema.json` with `validate` → `[]`; provider order and names; every P2 row; P3
  fields incl. a 3-entry tiered cost and a cost without cache rates; P5 rows for claude, openai, antigravity; every P6
  row (openrouter `anthropic/…`, `openai/…`, other; opencode Chat; cheaper-inference none); unavailable catalog left
  out; model without formats left out; manifest exact. Negatives: a document with a model missing `id` fails the
  schema check; the openai provider carries no `headers` (no lossy header). Tags: document and field tests
  `[feature=pi-config use-case=uc-pi-1 …]`; manifest `[feature=pi-config use-case=uc-pi-3 …]`; the P2 route, P5 and P6
  compat tests, which decide what pi sends, `[feature=pi-inference use-case=uc-pi-5 tier=unit …]` (one positive and
  one negative at least).
- **depends on**: 3.2
- **gates**:
  1. `{bun} test packages/dialect-pi` → exit `0`
  2. `{bun} run coverage --workspace packages/dialect-pi` → `unit[packages/dialect-pi]: scoped coverage PASS (100%, complete)`
  3. `{bun} run test:arch && {bun} run typecheck` → exit `0`
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | schema error `additionalProperties` on a model field | a field name not in pi's schema | the rule text is wrong or misread: E1 to the `plan` agent with the error; never drop the schema check |
  | `exactOptionalPropertyTypes` errors | `undefined` written into an optional field | spread conditionally, as `opencode-config-codec.ts:101-113` does |

- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f packages/dialect-pi/src/adapters/inbound/pi-config-codec.ts packages/dialect-pi/tests/unit/pi-config-codec.test.ts`.
- **returns**: diff, gate outputs.

### Step 3.4 — Component suite over the whole reference catalog

- **runs in**: subagent `general` (same subagent, after 3.3)
- **action**: `create`
- **target**: `{worktree}/packages/dialect-pi/tests/component/pi-catalog.test.ts`
- **content**: load `docs/reference/specs/models-opencode-reference.json` (the repository's pinned reference catalog;
  its loader is the one `packages/dialect-opencode/tests/component/variants-parity.test.ts` uses), build one
  `DetailedCatalog` per proxy provider whose reference provider exists (`REFERENCE_PROVIDER` in
  `packages/core/src/domain/model-details.ts:63`), with `formats` assigned per provider as the provider packages do
  (claude Messages; antigravity Gemini; openai Responses; gateways: the reference model's `aiSdkPackage` format), run
  `PiConfigCodec.config`, and assert: (positive, `[feature=pi-inference use-case=uc-pi-5 tier=component
  polarity=positive]`) the document validates against pi's schema; every model's `api` is the `PI_API` row of one of
  its formats; every `thinkingLevelMap` value is a string or `null` and, on `google-generative-ai`, within
  `minimal`–`high`; every `cost` has the four rates; (negative, `polarity=negative`) a catalog whose models all lack
  formats yields a provider with an empty `models` list that still validates, and a model whose only format is
  unknown is absent. Report the model count checked in the test name.
- **depends on**: 3.3
- **gates**:
  1. `{bun} test packages/dialect-pi/tests/component` → exit `0`, the model count printed in the test name ≥ 1
  2. `{bun} run coverage --workspace packages/dialect-pi` → scoped PASS
- **problems**: an empty provider `models` list fails pi's schema → P1 must leave such a provider out; E1 to the `plan` agent (rule change), never weaken the assertion.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f packages/dialect-pi/tests/component/pi-catalog.test.ts`.
- **returns**: diff, gate outputs.

### Step 3.5 — Stage 3 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run typecheck && {bun} run test:arch && {bun} run coverage`
- **depends on**: 3.1–3.4
- **gates**: 1. → exit `0`, `unit: coverage gate PASS`; 2. `ls {worktree}/packages/dialect-pi/tests` → `component e2e live unit`; 3. commit per rule 10.
- **problems**: a failure → reopen the owning step.
- **escalation**: E1
- **failure**: stage 4 does not start.
- **returns**: n/a

## Stage 4 — Routes, command and wiring in `apps/proxy`

**Why.** uc-pi-1 … uc-pi-3 are reached through the CLI and the daemon; the composition root is the only place that
wires concrete codecs (`AGENTS.md` §2). Every route is in the OpenAPI document and the API reference, enforced by
`apps/proxy/tests/unit/docs-in-step.test.ts:93-123` and `apps/proxy/tests/e2e/docs.test.ts:44-130`.

**What.** `GET /.well-known/pi` (open), `GET /pi/models.json` (token), `pi-config` command; OpenAPI paths and schemas;
API reference rows; unit, component and e2e tests.

**Enter gate.** Stage 3 gate green.

### Step 4.1 — Route handler

- **runs in**: subagent `general`
- **action**: `edit`
- **target**: `{worktree}/apps/proxy/src/adapters/inbound/http/route-handler.ts`
- **content**: import `PiConfigPort` and `PI_CONFIG_PATH`; `export const PI_WELL_KNOWN_PATH = "/.well-known/pi"`;
  `RoutePorts` gains `readonly pi: PiConfigPort`; after line 83 add the open `GET PI_WELL_KNOWN_PATH` →
  `json(this.ports.pi.manifest(this.ports.origin))`; line 84's `own` set adds `request.path === PI_CONFIG_PATH`; after
  line 102 add `if (request.path === PI_CONFIG_PATH) return json(this.ports.pi.config(await
  this.ports.describe.describeModels(), this.ports.origin));`. Unit tests in `apps/proxy/tests/unit/daemon.test.ts`:
  wire `pi: new PiConfigCodec()` at line 248; new tests: `GET /.well-known/pi` open (positive), `POST` → 404
  (negative); `GET /pi/models.json` with token → 200 and `["ap-claude","ap-antigravity"]` keys (positive), without
  token → 401 (negative), `POST` → 404 `no route POST /pi/models.json` (negative); tags per uc-pi-2/uc-pi-3, tier unit.
- **depends on**: stage 3
- **gates**: 1. `{bun} test apps/proxy/tests/unit/daemon.test.ts` → exit `0` (the whole-project typecheck is gate 1 of step 4.3, once the container is wired).
- **problems**: `bun test` fails to load the file because the container no longer compiles → not expected (`bun test` transpiles per file); if it occurs, run 4.1–4.3 and take this gate after 4.3.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- apps/proxy/src/adapters/inbound/http apps/proxy/tests/unit/daemon.test.ts`.
- **returns**: diff, gate outputs.

### Step 4.2 — `pi-config` command

- **runs in**: subagent `general` (same subagent, after 4.1)
- **action**: `edit`
- **target**: `{worktree}/apps/proxy/src/adapters/inbound/cli/commands/catalog-commands.ts`
- **content**: header line 1 adds `pi-config`; `PI_CONFIG_HELP` modelled on lines 49-59 (`name: "pi-config"`,
  synopsis `["pi-config"]`, description "print the pi models.json document of GET /pi/models.json", exit codes as
  `opencode-config`, examples `bun run proxy pi-config` and `bun run proxy pi-config > /tmp/pi/models.json`);
  `PiConfigCommand` modelled on `OpencodeConfigCommand` (lines 126-140) with `noArguments(args, "pi-config")`. In
  `proxy-commands.ts` `CliPorts` gains `readonly pi: PiConfigPort` and the program help lists `PI_CONFIG_HELP` after
  `opencode-config`. Unit tests in `apps/proxy/tests/unit/cli-commands.test.ts`: fake `PiConfig extends PiConfigPort`
  beside lines 81-88; help row beside line 186; the name list at line 205 gains `"pi-config"` after
  `"opencode-config"`; usage row beside line 263 `[["pi-config","x"],"pi-config takes no arguments","pi-config"]`
  (negative); `pi-config` prints the fake's document (positive).
- **depends on**: 4.1
- **gates**: 1. `{bun} test apps/proxy/tests/unit/cli-commands.test.ts` → exit `0` (after 4.3).
- **problems**: help ordering assertion fails → follow the order of `proxy-commands.ts`, update the list once.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- apps/proxy/src/adapters/inbound/cli apps/proxy/tests/unit/cli-commands.test.ts`.
- **returns**: diff, gate outputs.

### Step 4.3 — Composition root

- **runs in**: subagent `general` (same subagent, after 4.2)
- **action**: `edit`
- **target**: `{worktree}/apps/proxy/src/composition/container.ts`
- **content**: import `PiConfigCodec` from `@accounts-proxy/dialect-pi/adapters/inbound/pi-config-codec.ts` and
  `PiConfigCommand`; beside line 615 `const pi = new PiConfigCodec();`; pass `pi` into the `RouteHandler` ports and
  the CLI ports; register `new PiConfigCommand(ports.models, ports.pi, ports.origin)` after line 731.
- **depends on**: 4.2
- **gates**:
  1. `{bun} run typecheck` → exit `0`
  2. `{bun} run test` → exit `0`
  3. `{bun} run proxy help pi-config` (temporary `ACCOUNTS_PROXY_HOME={logs}/home-help`) → exit `0`, prints the synopsis `pi-config`
- **problems**: none beyond compile errors.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- apps/proxy/src/composition`.
- **returns**: diff, gate outputs.

### Step 4.4 — Documentation lists checked in step

- **runs in**: subagent `general` (same subagent, after 4.3)
- **action**: `edit`
- **target**: `{worktree}/docs/reference/2026-10-17-19-26-proxy-openapi.json`
- **content**: add `paths["/.well-known/pi"].get` (no security, operationId `piManifest`, 200 schema `PiManifest`) and
  `paths["/pi/models.json"].get` (bearer security as `/opencode/config.json`, operationId `piConfig`, 200 schema
  `PiConfig` described as "a pi models.json document; it validates against pi's published schema
  (docs/reference/specs/pi-models-schema.json, https://pi.dev/schemas/models.schema.json)", 401 as the opencode
  path); `components.schemas.PiManifest` (`auth.command` string array, `auth.env`, `config.url`) and `PiConfig`
  (`$schema`, `providers` object). In `docs/reference/2026-10-17-19-26-proxy-api.md` add the rows
  `| \`GET /.well-known/pi\` |` and `| \`GET /pi/models.json\` |` beside the opencode rows and the CLI row `| \`pi-config\` |
  prints the document of \`GET /pi/models.json\` |` after line 150. In `apps/proxy/tests/unit/docs-in-step.test.ts`
  import `PI_WELL_KNOWN_PATH` and `PI_CONFIG_PATH`, add both to `codeOperations()` (lines 100-101) and `"pi-config"`
  to the synopsis list at line 156 after `"opencode-config"`. In `apps/proxy/tests/e2e/docs.test.ts` add PROBES rows
  beside lines 46-48: `/.well-known/pi` 200; `/pi/models.json` 200 with token and 401 without. In
  `apps/proxy/tests/e2e/cli.test.ts:63` add `"pi-config"` to the list.
- **depends on**: 4.3
- **gates**:
  1. `{bun} test apps/proxy/tests/unit/docs-in-step.test.ts` → exit `0`
  2. `{bun} scripts/gate/lint-docs.ts` → exit `0`
  3. `jq -e '.paths["/pi/models.json"].get.operationId=="piConfig" and .paths["/.well-known/pi"].get.operationId=="piManifest"' docs/reference/2026-10-17-19-26-proxy-openapi.json` → `true`
- **problems**: docs-in-step reports a constant mismatch → align the document with the code, never the code with the document.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- docs/reference apps/proxy/tests`.
- **returns**: diff, gate outputs.

### Step 4.5 — Component suite of feature `pi-config`

- **runs in**: subagent `general` (same subagent, after 4.4)
- **action**: `create`
- **target**: `{worktree}/apps/proxy/tests/component/pi-config.test.ts`
- **content**: in process, the real `RouteHandler`, `PiConfigCodec`, `PiConfigCommand` with the local fakes the
  existing `apps/proxy/tests/component/*.test.ts` use for the catalog (the subagent names the fake it reuses); six
  scenarios, one positive and one negative per use case: uc-pi-1 command prints a schema-valid document / `pi-config x`
  exits 2 with empty stdout; uc-pi-2 `GET /pi/models.json` with token equals the command's document / without token
  401 `{"error":{"code":"unauthorized",…}}`; uc-pi-3 manifest exact / `POST /.well-known/pi` 404. Tags
  `[feature=pi-config use-case=uc-pi-N tier=component polarity=…]`.
- **depends on**: 4.4
- **gates**: 1. `{bun} test apps/proxy/tests/component/pi-config.test.ts` → exit `0`, 6 tests.
- **problems**: no catalog fake exists in process → use the route handler with a `DescribeModelsPort` fake defined in the test file (fakes extend the port).
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f apps/proxy/tests/component/pi-config.test.ts`.
- **returns**: diff, gate outputs.

### Step 4.6 — e2e: configuration through the real process

- **runs in**: subagent `general` (same subagent, after 4.5)
- **action**: `create`
- **target**: `{worktree}/apps/proxy/tests/e2e/pi-config.test.ts`
- **content**: modelled on `apps/proxy/tests/e2e/model-catalog.test.ts:5-46` (setup) and `:94-120` (daemon); schema
  `spec("pi-models-schema.json")`. Scenarios: uc-pi-1 `run(["pi-config"])` → exit 0 and `validate(schema, doc)` →
  `[]`, providers equal the available ones, a provider without an account absent (positive); `run(["pi-config","x"])`
  → exit 2 (negative). uc-pi-2 daemon `GET /pi/models.json` with token → equals the CLI document (positive); without
  token → 401 (negative). uc-pi-3 `GET /.well-known/pi` → `{auth: {command: ["env", "ACCOUNTS_PROXY_HOME=<home>",
  process.execPath, ENTRY, "token"], env: "ACCOUNTS_PROXY_TOKEN"}, config: {url: "<daemon>/pi/models.json"}}`
  (positive); `POST` → 404 (negative). Tags tier `e2e`.
- **depends on**: 4.5
- **gates**: 1. `{bun} test --timeout 120000 apps/proxy/tests/e2e/pi-config.test.ts` → exit `0`, 6 tests.
- **problems**: failures that also occur in the baseline e2e run (macOS) → compare with `{record}` § Baseline gate; a pre-existing harness failure blocks this step: E1 to the user.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f apps/proxy/tests/e2e/pi-config.test.ts`.
- **returns**: diff, gate outputs.

### Step 4.7 — e2e: pi-shaped requests reach every format route

- **runs in**: subagent `general` (same subagent, after 4.6)
- **action**: `create`
- **target**: `{worktree}/apps/proxy/tests/e2e/pi-routing.test.ts`
- **content**: a signed-in daemon (`startSignedInDaemon`, `tests/support/e2e/proxy-process.ts:258-267`) with replay
  upstreams; read the served `GET /pi/models.json`; for each cell take the model's `baseUrl` and build the request
  exactly as pi 1.5.2 does (URL rules and auth headers: product design P2; bodies minimal per format):
  claude × `anthropic-messages` → `POST {baseUrl}/v1/messages?beta=true`, `x-api-key`; antigravity ×
  `google-generative-ai` → `POST {baseUrl}/models/{id}:streamGenerateContent?alt=sse`, `x-goog-api-key`, body with a
  string-derived `systemInstruction` `{role:"user",parts:[{text}]}` and a `parametersJsonSchema` tool; openai ×
  `openai-responses` → `POST {baseUrl}/responses`, `Authorization: Bearer`, `store:false`, a `developer` input item,
  no `max_output_tokens`; cheaper-inference × `openai-completions` → `POST {baseUrl}/chat/completions`, Bearer,
  `store:false`, `max_completion_tokens`. Each cell: positive (the replay upstream receives the request; the client
  gets 200) and negative (wrong token → 401 before any upstream call: `upstreams.find(...)` count unchanged). Which
  replay seams exist for openai and cheaper-inference is read first from `tests/support/e2e/upstreams.ts` and the
  e2e tests that use them (`apps/proxy/tests/e2e/*.test.ts`); a missing seam is not worked around. Tags
  `[feature=pi-inference use-case=uc-pi-5 tier=e2e polarity=…]`.
- **depends on**: 4.6
- **gates**: 1. `{bun} test --timeout 120000 apps/proxy/tests/e2e/pi-routing.test.ts` → exit `0`, 8 tests.
- **problems**: a cell without a replay seam → stop; E1 to the `plan` agent (add the seam as its own step, or move the cell to the live tier only); never fake an upstream inside the test.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f apps/proxy/tests/e2e/pi-routing.test.ts`.
- **returns**: diff, gate outputs, the list of seams used.

### Step 4.8 — e2e coverage of the new route code

- **runs in**: subagent `general` (same subagent, after 4.7)
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run test:e2e > {logs}/e2e-stage4.log 2>&1; echo "exit=$?"`
- **depends on**: 4.7
- **gates**:
  1. → the e2e gate line for `packages/dialect-pi/src/**` and the changed `apps/proxy/src/**` files: 100 %, complete
  2. any other failure → identical to the baseline list in `{record}` § Baseline gate (no new failure)
- **problems**: a branch of `PiConfigCodec` no e2e scenario reaches (for example a P6 gateway rule) → add a gateway catalog to the e2e home's replay so the branch runs; never add an `E2E_DEFERRED` entry (`scripts/gate/e2e-deferred.ts` phases are closed).
- **escalation**: E1
- **failure**: stage 4 gate red.
- **returns**: the gate lines.

### Step 4.9 — Stage 4 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run typecheck && {bun} run test:arch && {bun} run coverage && {bun} run test:e2e && {bun} scripts/gate/lint-docs.ts`
- **depends on**: 4.1–4.8
- **gates**: 1. → each command's PASS line, or for `test:e2e` exactly the baseline's pre-existing failures and nothing new; 2. commit per rule 10.
- **problems**: a new failure → reopen the owning step.
- **escalation**: E1
- **failure**: stage 5 does not start.
- **returns**: n/a

## Stage 5 — `apps/pi-extension`

**Why.** uc-pi-4 and uc-pi-6: the user chose automatic registration (decision "Full, with auto-load", 2026-11-15).
pi loads extensions with jiti 2.7.0 inside its own Node.js process (pi `dist/core/extensions/loader.js:477-490`), awaits
an async factory before applying provider registrations (pi `docs/extensions.md:213-250`), and exits `1` when a
factory throws (`loader.js:533-547`, `dist/main.js:803-808`). Extension models get no defaults
(`dist/core/provider-composer.js:132-148`) and require `id`, `name`, `input`, `cost`, `reasoning`, `contextWindow`,
`maxTokens` (`dist/core/extensions/types.d.ts:1512-1547`).

**What.** `{worktree}/apps/pi-extension/` with every file of the architecture design §5, its four test tiers,
`tests/arch/pi-extension-runtime.test.ts`, the workspace in `tests/arch/architecture.test.ts:207-223`,
`scripts/gate/scaffold-packages.ts` and `bun.lock`.

**Enter gate.** Stage 4 gate green.

### Step 5.1 — Scaffold the workspace

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/package.json`
- **content**: `{"name": "@accounts-proxy/pi-extension", "version": "0.1.0", "private": true, "license": "MIT", "type":
  "module", "description": "pi extension: registers the proxy's providers from /.well-known/pi at pi startup.",
  "exports": {"./*": "./src/*"}, "pi": {"extensions": ["./src/main/extension.ts"]}, "devDependencies":
  {"@accounts-proxy/test-support": "workspace:*"}}` (no `dependencies`: pi `docs/packages.md:100-114`); directories
  `tests/{unit,component,live,e2e}`; a row in `scripts/gate/scaffold-packages.ts` after `apps/proxy`;
  `"@accounts-proxy/pi-extension"` in the sorted list of `tests/arch/architecture.test.ts:207-223`; `{bun} install`.
- **depends on**: stage 4
- **gates**:
  1. `git -C {worktree} diff -- bun.lock | grep '^[+-][^+-]' | grep -v pi-extension` → no output
  2. `{bun} install --frozen-lockfile` → exit `0`
  3. `{bun} run test:arch` → exit `0` once 5.5 exists (until then: only the workspace-list assertion is checked)
- **problems**: as step 3.1.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- bun.lock tests/arch scripts/gate && rm -rf apps/pi-extension`.
- **returns**: diff, gate outputs.

### Step 5.2 — Outbound ports

- **runs in**: subagent `general` (same subagent, after 5.1)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/src/ports/outbound/` — `proxy-discovery.ts`, `token-source.ts`, `pi-host.ts`
- **content**: abstract classes `ProxyDiscoveryPort` (`manifest(): Promise<PiManifest>`, `config(url: string, token:
  string): Promise<JsonObject>`), `TokenSourcePort` (`token(command: readonly string[]): Promise<string>`),
  `PiHostPort` (`registerProvider(id: string, config: PiProviderConfig): void`, `warn(message: string): void`,
  `readEnv(name: string): string | undefined`, `setEnv(name: string, value: string): void`); types `PiManifest`
  (`{auth: {command: readonly string[]; env: string}; config: {url: string}}`), `JsonObject`, `PiProviderConfig` and
  `PiModelConfig`, the last two quoting the field list of pi 1.5.2 `dist/core/extensions/types.d.ts:1459-1547`
  (`name?`, `baseUrl?`, `apiKey?`, `api?`, `models`, `refreshModels?`; model `id`, `name`, `api?`, `baseUrl?`,
  `input`, `cost`, `reasoning`, `contextWindow`, `maxTokens`, `thinkingLevelMap?`, `compat?`). Pure TypeScript.
- **depends on**: 5.1
- **gates**: 1. `{bun} run typecheck` → exit `0`
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `rm -rf apps/pi-extension/src/ports`.
- **returns**: diff.

### Step 5.3 — Application service

- **runs in**: subagent `general` (same subagent, after 5.2)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/src/application/register-providers.ts`
- **content**: `RegisterProvidersService` (constructor: the three ports, abstraction types) and `piDefaults(model)`
  exactly as architecture design §5 states. `run()`: `manifest = await discovery.manifest()`; if
  `host.readEnv(manifest.auth.env)` is unset, `host.setEnv(manifest.auth.env, await tokens.token(manifest.auth.command))`;
  `doc = await discovery.config(manifest.config.url, token)`; validate the shape (`providers` object; each provider
  `models` array; each model `id` string) else throw `not a pi configuration`; for each provider id `registerProvider(id,
  {name, apiKey, models: models.map(piDefaults), refreshModels})`; any error → `host.warn("accounts-proxy: <cause>; no
  ap- providers registered")` once, return normally. `refreshModels` re-runs manifest → config and returns
  `doc.providers[id].models.map(piDefaults)` (`[]` when the provider disappeared), rejecting on failure. Unit tests
  `apps/pi-extension/tests/unit/register-providers.test.ts`, one per branch (env preset kept; env unset → token set;
  manifest failure; token failure; config 401; malformed document (three shapes); refresh success; refresh failure;
  provider gone on refresh; `piDefaults` fills each of the six fields and keeps stated ones), tags uc-pi-4 / uc-pi-6
  tier unit.
- **depends on**: 5.2
- **gates**: 1. `{bun} test apps/pi-extension/tests/unit/register-providers.test.ts` → exit `0`; 2. `{bun} run coverage --workspace apps/pi-extension` → 100 % for `register-providers.ts` (per-file line).
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `rm -rf apps/pi-extension/src/application apps/pi-extension/tests/unit/register-providers.test.ts`.
- **returns**: diff, gate outputs.

### Step 5.4 — Outbound adapters

- **runs in**: subagent `general` (same subagent, after 5.3)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/src/adapters/outbound/` — `http-proxy-discovery.ts`, `exec-token-source.ts`,
  `extension-pi-host.ts`
- **content**: as architecture design §5. `HttpProxyDiscovery(fetchFn, baseUrl)`: `GET {baseUrl}/.well-known/pi`;
  `GET url` with `authorization: Bearer <token>`; non-2xx → error naming the status and the proxy's `error.message`;
  5000 ms `AbortSignal.timeout`. `ExecTokenSource(execFileFn)`: `execFile(command[0], command.slice(1), {timeout:
  10000})`, trimmed stdout, empty → error `token command printed nothing`. `ExtensionPiHost(api, env, stderr)`:
  `registerProvider` → `api.registerProvider`; `warn` → `stderr.write(message + "\n")`; `readEnv`/`setEnv` on `env`.
  Only `node:*` imports and globals available in Node.js 22. Unit tests per adapter with injected fakes (no I/O), one
  per branch incl. timeout and non-2xx, tags uc-pi-4 tier unit.
- **depends on**: 5.3
- **gates**: 1. `{bun} test apps/pi-extension/tests/unit` → exit `0`; 2. per-file 100 % for the three adapters in `{bun} run coverage --workspace apps/pi-extension`.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `rm -rf apps/pi-extension/src/adapters` and their tests.
- **returns**: diff, gate outputs.

### Step 5.5 — Composition, entry and the runtime law

- **runs in**: subagent `general` (same subagent, after 5.4)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/src/composition/extension-container.ts`, `{worktree}/apps/pi-extension/src/main/extension.ts`, `{worktree}/tests/arch/pi-extension-runtime.test.ts`
- **content**: `buildExtension(api, env)` wires `HttpProxyDiscovery(globalThis.fetch, env.ACCOUNTS_PROXY_URL ??
  "http://127.0.0.1:4141")`, `ExecTokenSource(execFile)`, `ExtensionPiHost(api, env, process.stderr)`, returns the
  service. `main/extension.ts`: `export default async function (pi: PiExtensionApi): Promise<void> { await
  buildExtension(pi, process.env).run(); }` (imports composition only). `tests/arch/pi-extension-runtime.test.ts`:
  every `.ts` under `apps/pi-extension/src` contains no `Bun.`, no `from "bun`, no `import.meta.dir`; positive test on
  the real tree, negative test on a synthetic string (gate self-test, as `architecture.test.ts:205-230`). Composition
  and main are covered by the component suite (step 5.6: the default export run with a fake api and
  `ACCOUNTS_PROXY_URL=http://127.0.0.1:9`, one warning) and by the e2e tier (step 5.7); the unit tier stays free of I/O.
- **depends on**: 5.4
- **gates**: 1. `{bun} run test:arch` → exit `0`; 2. `{bun} run typecheck` → exit `0` (the scoped 100 % coverage gate of the workspace is taken in step 5.6, once the component suite covers composition and main).
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `rm -rf apps/pi-extension/src/composition apps/pi-extension/src/main tests/arch/pi-extension-runtime.test.ts`.
- **returns**: diff, gate outputs.

### Step 5.6 — Component suite of feature `pi-extension`

- **runs in**: subagent `general` (same subagent, after 5.5)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/tests/component/register-providers.test.ts`
- **content**: the real service and adapters, in process, with local fakes for `fetch` (serving a document produced
  by the real `PiConfigCodec` over a fixture catalog: `@accounts-proxy/dialect-pi` in `devDependencies`, plus a
  `bun install` lock check as step 3.1 gate 1) and `execFile`. Scenarios: uc-pi-4 positive (every provider registered
  with pi-valid models) / negative (the default export of `main/extension.ts` with `ACCOUNTS_PROXY_URL=http://127.0.0.1:9`
  set for the test and restored after it → one warning, zero registrations); uc-pi-6 positive (refresh
  returns the updated models after the fake document changes) / negative (refresh rejects when the fake answers 503,
  previous registration untouched). Tags tier component.
- **depends on**: 5.5
- **gates**: 1. `{bun} test apps/pi-extension/tests/component` → exit `0`, 4 tests; 2. lock check → no unrelated line; 3. `{bun} run coverage --workspace apps/pi-extension` → `scoped coverage PASS (100%, complete)`.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f apps/pi-extension/tests/component/register-providers.test.ts` and the devDependency.
- **returns**: diff, gate outputs.

### Step 5.7 — e2e suite: the real entry against a real daemon

- **runs in**: subagent `general` (same subagent, after 5.6)
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/tests/e2e/extension.test.ts` and `{worktree}/apps/pi-extension/tests/e2e/harness.ts`
- **content**: `harness.ts` imports the default export of `@accounts-proxy/pi-extension/main/extension.ts`, passes a
  recording fake `ExtensionAPI`, runs it, then calls each recorded `refreshModels` (positive) and prints a JSON summary
  (`registered` ids, model counts, `warnings`, refresh results) to stdout. `extension.test.ts` starts a daemon
  (`makeHome` + `startDaemon`, `tests/support/e2e/proxy-process.ts:140-150,221-250`) and spawns
  `{bun} --preload scripts/gate/e2e-coverage-preload.ts apps/pi-extension/tests/e2e/harness.ts` with
  `ACCOUNTS_PROXY_URL=<daemon url>` and the inherited `ACCOUNTS_PROXY_E2E_COVERAGE_DIR`, `ACCOUNTS_PROXY_TOKEN` unset.
  Scenarios: uc-pi-4 positive (every available `ap-` provider registered, token obtained through the manifest's real
  command); uc-pi-4 negatives (a) closed port `http://127.0.0.1:9`; (b) config 401 with a wrong preset
  `ACCOUNTS_PROXY_TOKEN`; (c) token command exits `1`, (d) token command exceeds 10000 ms, (e) the configuration is
  not a pi document — (c)–(e) through a manifest stub, a `Bun.serve` on port 0 inside the test that answers
  `/.well-known/pi` with `auth.command` `["false"]`, `["sleep", "11"]` or the real command, and `config.url` pointing at
  the real daemon or at a stub path answering `{"providers": 1}`; uc-pi-6 positive (refresh returns the models) /
  negative (daemon stopped before refresh → rejection recorded). Every negative asserts one warning and zero
  registrations. The child exits through its normal path so the preload writes coverage.
- **depends on**: 5.6
- **gates**: 1. `{bun} test --timeout 120000 apps/pi-extension/tests/e2e` → exit `0`, every scenario listed.
- **problems**: a branch still unreachable from outside the process → stop; E1 to the `plan` agent; never add a test-only branch to product code.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -rf apps/pi-extension/tests/e2e`.
- **returns**: diff, gate outputs.

### Step 5.8 — e2e coverage of the extension

- **runs in**: subagent `general` (same subagent, after 5.7)
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run test:e2e > {logs}/e2e-stage5.log 2>&1; echo "exit=$?"`
- **depends on**: 5.7
- **gates**: 1. → `apps/pi-extension/src/**` 100 %, complete in the e2e gate; 2. other failures identical to the baseline list.
- **problems**: a line of `apps/pi-extension/src/**` unreached in e2e → add the scenario that reaches it to step 5.7 through the manifest stub; never add an `E2E_DEFERRED` entry.
- **escalation**: E1
- **failure**: stage 5 gate red.
- **returns**: the gate lines.

### Step 5.9 — Stage 5 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run typecheck && {bun} run test:arch && {bun} run coverage && {bun} run test:e2e`
- **depends on**: 5.1–5.8
- **gates**: 1. → PASS lines, `test:e2e` with no failure outside the baseline list; 2. commit per rule 10.
- **problems**: a failure → reopen the owning step.
- **escalation**: E1
- **failure**: stage 6 does not start.
- **returns**: n/a

## Stage 6 — Documentation in step

**Why.** `AGENTS.md` of the repository requires documents to change with the code (docs-in-step test,
`scripts/gate/lint-docs.ts`); the client setup reference documents every client
(`docs/reference/2026-10-17-19-26-client-setup.md:115` for opencode); the diagram names every port and codec
(`docs/architecture.drawio:22,28`, checked by `apps/proxy/tests/unit/docs-in-step.test.ts:278`).

**What.** `{worktree}/docs/reference/{ts}-pi-config-rules.md` (`{ts}` from `date +%Y-%m-%d-%H-%M` at step 6.1,
recorded in `{record}` and used by 6.2–6.6); a pi section in the client setup reference; `README.md`; `AGENTS.md`;
`docs/architecture.drawio`; the product design §4 replaced by a link.

**Enter gate.** Stage 5 gate green.

### Step 6.1 — Rules reference

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/docs/reference/{ts}-pi-config-rules.md`
- **content**: title `# pi configuration rules P1–P7`; a provenance table (pi 1.5.2 install path, schema URL and
  SHA-256 `3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc`, fetched 2026-11-15, file
  `docs/reference/specs/pi-models-schema.json`); the P1–P7 table moved verbatim from the product design §4; a section
  "Request shapes pi sends" with the facts the rules rely on (P2 URL joins, auth headers, G: system prompt role, H:
  Gemini tools as `parametersJsonSchema`, no `toolConfig` for prefixed ids, `systemInstruction` role `user`), each
  with its pi path and line. In the product design, §4's table is replaced by one line linking this document.
- **depends on**: stage 5
- **gates**: 1. `grep -c '^| P[1-7] |' {worktree}/docs/reference/{ts}-pi-config-rules.md` → `7`; 2. `grep -c '^| P[1-7] |' {worktree}/docs/design/2026-11-15-23-52-pi-compatibility-product.md` → `0`; 3. `{bun} scripts/gate/lint-docs.ts` → exit `0`.
- **problems**: lint rejects the name → use the timestamp printed by `date`, never an edited one.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- docs/design && rm docs/reference/{ts}-pi-config-rules.md`.
- **returns**: diff, gate outputs, `{ts}`.

### Step 6.2 — Client setup reference

- **runs in**: subagent `general` (same subagent, after 6.1)
- **action**: `edit`
- **target**: `{worktree}/docs/reference/2026-10-17-19-26-client-setup.md`
- **content**: a section `## pi` after the opencode section, self-sufficient: prerequisites (pi ≥ 1.5.2, daemon
  running); **Automatic (extension)**: `pi install /Users/mavasbel/Dev/repos/devtools/accounts-proxy/apps/pi-extension`
  (records the path in `~/.pi/agent/settings.json`; pi `docs/packages.md:12-21`), `ACCOUNTS_PROXY_URL` for a
  non-default port, what happens when the daemon is down (warning, pi starts); trying it without installing:
  `pi -e /Users/mavasbel/Dev/repos/devtools/accounts-proxy/apps/pi-extension/src/main/extension.ts`; **Static file**:
  `bun run proxy pi-config > ~/.pi/agent/models.json` and `export ACCOUNTS_PROXY_TOKEN="$(bun run proxy token)"`,
  re-run after catalog changes; **Choosing a model**: always `ap-<provider>/<provider>/<model>` or `--provider
  ap-<provider>` (a bare `openrouter/...` resolves to pi's built-in OpenRouter: pi `dist/core/model-resolver.js:61-77`),
  thinking suffix `:high`; four runnable examples (`pi --list-models ap-`, one `-p` turn on `ap-claude`, one on
  `ap-openrouter` with the full prefix, one with `:high`); a link to the rules reference.
- **depends on**: 6.1
- **gates**: 1. for each string `pi install /Users/mavasbel/Dev/repos/devtools/accounts-proxy/apps/pi-extension`, `bun run proxy pi-config`, `ap-openrouter/openrouter/`, `--list-models ap-`: `grep -c -F -- '<string>' {target}` → `1` or more; 2. `{bun} scripts/gate/lint-docs.ts` → exit `0`.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- docs/reference/2026-10-17-19-26-client-setup.md`.
- **returns**: diff, gate outputs.

### Step 6.3 — README

- **runs in**: subagent `general` (same subagent, after 6.2)
- **action**: `edit`
- **target**: `{worktree}/README.md`
- **content**: wherever opencode is listed as a supported client (the subagent quotes each line before editing), add
  pi with a link to the client setup section `#pi`; in the command list add `pi-config`; in the route list add
  `GET /pi/models.json` and `GET /.well-known/pi`.
- **depends on**: 6.2
- **gates**: 1. `grep -n 'pi-config\|/.well-known/pi\|/pi/models.json' {worktree}/README.md` → at least 3 lines; 2. `{bun} test apps/proxy/tests/unit/docs-in-step.test.ts` → exit `0`; 3. lint → exit `0`.
- **problems**: docs-in-step compares a README matrix → keep the matrix unchanged (pi adds no format).
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- README.md`.
- **returns**: diff with the quoted original lines.

### Step 6.4 — AGENTS.md

- **runs in**: subagent `general` (same subagent, after 6.3)
- **action**: `edit`
- **target**: `{worktree}/AGENTS.md`
- **content**: line 123: `Every route except \`/health\`, \`/.well-known/opencode\` and \`/.well-known/pi\` requires the
  proxy token`; line 125: the manifests carry no secret (both); after line 133 a sentence: `The pi configuration (\`GET
  /pi/models.json\`, \`pi-config\`) uses pi's \`models.json\` schema, one \`ap-<provider>\` each, every model with its own
  \`api\` and \`baseUrl\` (rules P1–P7, linked to the rules reference of step 6.1)); \`apps/pi-extension\` registers them
  inside pi and runs in pi's Node.js process (no Bun API; \`tests/arch/pi-extension-runtime.test.ts\`).`; §2 workspace
  list: `apps/pi-extension: ports/outbound, application, adapters/outbound, composition, main (a pi extension)`.
- **depends on**: 6.3
- **gates**: 1. `grep -c 'well-known/pi' {worktree}/AGENTS.md` → ≥ 1; `grep -c 'pi-config-rules' {worktree}/AGENTS.md` → 1; 2. lint → exit `0`.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- AGENTS.md`.
- **returns**: diff.

### Step 6.5 — Architecture diagram

- **runs in**: subagent `general` (same subagent, after 6.4)
- **action**: `edit`
- **target**: `{worktree}/docs/architecture.drawio`
- **content**: cell `dialects` (line 22): add `dialect-pi` to the package list and `PiConfigPort ← PiConfigCodec (pi
  models.json, well-known manifest)`; cell `core` (line 28): add `PiConfigPort` to `ports/inbound`; a new cell
  `pi-extension` on the Components page (`apps/pi-extension␤RegisterProvidersService · ProxyDiscoveryPort ·
  TokenSourcePort · PiHostPort (runs inside pi)`) with an edge to cell `http` labelled `GET /.well-known/pi,
  /pi/models.json`; cell `f-route` (line 95): `/.well-known/opencode and /.well-known/pi need none`. Page names
  unchanged.
- **depends on**: 6.4
- **gates**: 1. `{bun} test apps/proxy/tests/unit/docs-in-step.test.ts` → exit `0` (every CamelCase name declared; four page names); 2. `xmllint --noout {target}` → exit `0`.
- **problems**: `xmllint` missing → `{bun} -e` parse with the docs-in-step decoder as the gate instead, recorded.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- docs/architecture.drawio`.
- **returns**: diff.

### Step 6.6 — Session record cross-check of documents

- **runs in**: subagent `general` (same subagent, after 6.5)
- **action**: `review`
- **target**: `{worktree}/docs` and `{worktree}/README.md`, `{worktree}/AGENTS.md`
- **content**: every link added in 6.1–6.5 resolves to an existing file and heading; every path and command in the pi
  section of the client setup reference runs as printed (`pi --version`, `bun run proxy pi-config | jq -e .providers`,
  `bun run proxy help pi-config`), run against a temporary home, never against `{repo}/.cache`.
- **depends on**: 6.5
- **gates**: 1. `{bun} scripts/gate/lint-docs.ts` → exit `0`; 2. each command → exit `0` (pasted).
- **problems**: a printed command fails → fix the document, not the command.
- **escalation**: E1
- **failure**: reopen the owning step.
- **returns**: the command outputs.

### Step 6.7 — Stage 6 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} scripts/gate/lint-docs.ts && {bun} test apps/proxy/tests/unit/docs-in-step.test.ts tests/arch`
- **depends on**: 6.1–6.6
- **gates**: 1. → exit `0`; 2. commit per rule 10.
- **problems**: a failure → reopen the owning step.
- **escalation**: E1
- **failure**: stage 7 does not start.
- **returns**: n/a

## Stage 7 — Generated granularity report

**Why.** `AGENTS.md` 6.7 (user's global rules): coverage of features, use cases, dependencies and negative paths is
counted from scenario tags by a generated check, never by hand. The repository has no such check (`scripts/gate/`
lists no granularity script; no test name carries `use-case=`; search 2026-11-15).

**What.** `{worktree}/scripts/gate/granularity-report.ts`, its unit test, and a `verify` step.

**Enter gate.** Stage 6 gate green.

### Step 7.1 — The report

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/scripts/gate/granularity-report.ts`
- **content**: `GRANULARITY_DESIGNS = ["docs/design/2026-11-15-23-52-pi-compatibility-product.md"]`. For each design:
  features from `### Feature \`<id>\`` headings; use cases from `#### uc-…` headings under each; dependencies from the
  `Dependencies per use case` paragraph. It scans every `*.test.ts` under `packages/*/tests`, `apps/*/tests`, `tests/`
  for `[feature=… use-case=… tier=… (dependency=… )?polarity=…]` tags in test names. It fails (exit 1) listing each
  missing item: per use case, unit positive and negative; per feature, a component file holding positive and negative
  per use case; per use case, e2e positive and negative; per use case and dependency ≠ none, a live test with that
  `dependency=` positive and negative; any tag naming an unknown feature, use case, tier or dependency. It prints a
  table `feature | use case | tier | dependency | positive | negative` and `GRANULARITY: PASS (n scenarios)` or
  `GRANULARITY: FAIL (m missing)`. Unit tests `scripts/tests/unit/granularity-report.test.ts` over synthetic design
  and test texts: complete → pass; each missing kind → its failure line; unknown tag → failure.
- **depends on**: stage 6
- **gates**: 1. `{bun} test scripts/tests/unit/granularity-report.test.ts` → exit `0`; 2. `{bun} scripts/gate/granularity-report.ts` → exit `1` listing exactly the live rows (live suites do not exist until stage 8) and nothing else.
- **problems**: a component or e2e row missing → the owning test step (4.5–4.7, 5.6–5.7) is reopened.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -f scripts/gate/granularity-report.ts scripts/tests/unit/granularity-report.test.ts`.
- **returns**: diff, gate outputs.

### Step 7.2 — Add the report to verify

- **runs in**: subagent `general` (same subagent, after 7.1)
- **action**: `edit`
- **target**: `{worktree}/scripts/gate/verify.ts`
- **content**: a step `{ name: "granularity report", command: [bun, "scripts/gate/granularity-report.ts"] }` after the
  docs lint step (the subagent quotes the anchor line).
- **depends on**: 7.1
- **gates**: 1. `grep -n 'granularity report' {target}` → one line after the docs lint step.
- **problems**: none foreseen.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} checkout -- scripts/gate/verify.ts`.
- **returns**: diff.

### Step 7.3 — Stage 7 gate

- **runs in**: main session — stage gate
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} test scripts/tests/unit && {bun} scripts/gate/granularity-report.ts; echo "exit=$?"`
- **depends on**: 7.1, 7.2
- **gates**: 1. unit → exit `0`; 2. report → `exit=1` with only live rows missing (expected until stage 8); 3. commit per rule 10.
- **problems**: rows other than live missing → reopen the owning step.
- **escalation**: E1
- **failure**: stage 8 does not start.
- **returns**: n/a

## Stage 8 — Live tier with the real pi 1.5.2 binary

**Why.** Everything pi does on the wire is, until here, read from pi's code (planning record § Evidence gathered); the
live tier proves it with the real binary, the real accounts and the real upstreams, one live suite per external
dependency (`AGENTS.md` 6.5). Live suites run only with `ACCOUNTS_PROXY_LIVE=1` and never in `verify`
(`scripts/gate/run-tests.ts:5`).

**What.** `{worktree}/apps/pi-extension/tests/live/pi-binary.test.ts` (dependency `pi`) and
`pi-<provider>.test.ts` for `claude`, `antigravity`, `openai`, `openrouter`, `opencode`, `opencode-go`,
`cheaper-inference`; their green run recorded; the user's daemon restored.

**Enter gate.** Stage 7 gate green.

**Cells and models.** One cell per (provider, pi api) the provider serves: claude × `anthropic-messages`;
antigravity × `google-generative-ai`; openai × `openai-responses`; openrouter × `openai-completions`,
`openai-responses`, `anthropic-messages`; opencode and opencode-go × all four apis; cheaper-inference ×
`openai-completions`, `openai-responses`, `anthropic-messages` — 17 cells, each confirmed present in
`{logs}/catalog.json` by step 8.1. Models: claude `claude/claude-haiku-5-5`, antigravity `antigravity/gemini-3-flash`,
openai `openai/gpt-5.6-luna` (smallest model of each subscription family in the 2026-11-15 catalog); each gateway cell:
the model with the lowest `cost.input + cost.output` among the cell's models with `toolCall: true`, ties by id; the
thinking scenario uses the cheapest model of the cell with `reasoning: true`. A cell with no such model records the
exemption with the catalog evidence (antigravity has `reasoning: false` by rule P5, so its thinking scenario is exempt
by design). Spend bound: 17 cells × 3 turns of at most 64 output tokens plus one tool round trip, on the cheapest
models; the three subscription cells use plan usage.

### Step 8.1 — Write the live suites

- **runs in**: subagent `general`
- **action**: `create`
- **target**: `{worktree}/apps/pi-extension/tests/live/` (8 files)
- **content**: each file starts with `const live = process.env.ACCOUNTS_PROXY_LIVE === "1";` and uses
  `test.skipIf(!live)` (pattern of `apps/proxy/tests/live/cost-reconcile.test.ts:2-8`). Every pi run is
  `Bun.spawn(["/opt/homebrew/bin/pi", ...])` with `PI_CODING_AGENT_DIR` = a fresh temporary directory (removed in
  `afterEach`), `--no-session`, and a 120 s timeout. The cell table (cells and models above, resolved from
  `{logs}/catalog.json` by a script the subagent runs with the codec, like gate 2.3.1) is a constant in each provider
  file, its derivation pasted in `returns`.
  - `pi-binary.test.ts` (`dependency=pi`): uc-pi-4 positive: `pi -e {worktree}/apps/pi-extension/src/main/extension.ts
    --list-models ap-` → exit 0, every available `ap-` provider listed; negative: `ACCOUNTS_PROXY_URL=http://127.0.0.1:9`
    → exit 0, no `ap-` line, stderr names `accounts-proxy`. uc-pi-6 positive: a counting forwarder (`Bun.serve` on port
    0 forwarding every request to the daemon and counting `/.well-known/pi`) as `ACCOUNTS_PROXY_URL`;
    `--list-models ap-` → count ≥ 2 (startup registration + refresh); when it is 1, `pi -e … update --models` → count
    ≥ 2; negative: the forwarder answers 503 to every `/.well-known/pi` after the first → `--list-models ap-` still lists
    every provider, exit 0. uc-pi-5 positive: `-p --model ap-claude/claude/claude-haiku-5-5 "Reply with exactly: OK"`
    → stdout contains `OK`; negative: the static document (`bun run proxy pi-config` output written to
    `$PI_CODING_AGENT_DIR/models.json`, no `-e`) with `ACCOUNTS_PROXY_TOKEN=wrong` → exit ≠ 0, output names `401`.
  - `pi-<provider>.test.ts` (`dependency=<provider>`), per cell: uc-pi-5 positive (a) plain turn → `OK`; (b) tool turn:
    a temporary file holding `PINEAPPLE`, prompt `Use the read tool on <path> and reply with its single word` → stdout
    contains `PINEAPPLE`; (c) thinking turn `--model <ref>:high` (or the highest level the model's map allows) → exit 0
    with non-empty stdout; negatives through the static document: (d) `ACCOUNTS_PROXY_TOKEN=wrong` → exit ≠ 0 naming
    `401`; (e) an extra model `nosuch` in the provider's list, `--model ap-<provider>/<provider>/nosuch` → exit ≠ 0
    naming `unknown model`. Tags `[feature=pi-inference use-case=uc-pi-5 tier=live dependency=<provider> polarity=…]`.
- **depends on**: stage 7
- **gates**:
  1. `{bun} run typecheck` → exit `0`
  2. `{bun} test apps/pi-extension/tests/live` (without `ACCOUNTS_PROXY_LIVE`) → exit `0`, every test skipped
  3. `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS`
- **problems**: a cell absent from the catalog → record it with the `jq` evidence and leave it out of the table (the provider no longer serves that api); never invent a model.
- **escalation**: E1
- **failure**: rollback `git -C {worktree} rm -rf apps/pi-extension/tests/live/*.test.ts`.
- **returns**: diff, the cell table with its derivation, gate outputs.

### Step 8.2 — Hand the accounts to the worktree daemon

- **runs in**: main session — the user's running daemon and real accounts (live state; `AGENTS.md` 4.7)
- **action**: `run`
- **target**: the daemon on `127.0.0.1:4141`
- **content**: ask the user with the `question` tool to stop their daemon (Ctrl-C in its terminal, pid 96176 on
  2026-11-15) and confirm; then start the worktree daemon:
  `cd {worktree} && ACCOUNTS_PROXY_HOME=/Users/mavasbel/Dev/repos/devtools/accounts-proxy/.cache {bun} run proxy serve > {logs}/live-daemon.log 2>&1`
  as a background shell task.
- **depends on**: 8.1
- **gates**:
  1. before start: `lsof -nP -iTCP:4141 -sTCP:LISTEN` → no output
  2. after start: `curl -s http://127.0.0.1:4141/health` → `"status":"ok"` with the 7 providers
  3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4141/.well-known/pi` → `200`
- **problems**: the user declines → stage 8 is blocked; report it, never run two daemons on one accounts file.
- **escalation**: the user
- **failure**: stop the worktree daemon (`kill -INT <pid>`), ask the user to restart theirs; gate: `/health` ok from their daemon.
- **returns**: n/a

### Step 8.3 — Run the live tier

- **runs in**: main session — real accounts and spend
- **action**: `run`
- **target**: `{worktree}`
- **content**: `{bun} run test:live > {logs}/live.log 2>&1; echo "exit=$?"`
- **depends on**: 8.2
- **gates**:
  1. → `exit=0`; every test of `apps/pi-extension/tests/live` passed (not skipped), and the pre-existing
     `apps/proxy/tests/live/cost-reconcile.test.ts` result equals its baseline behaviour
  2. the per-cell table (cell, model, a/b/c/d/e result) pasted into `{record}` § Live
  3. the uc-pi-6 count and the command that produced it pasted
- **problems**:

  | Symptom | Cause | Handling |
  |---|---|---|
  | 429 / 5xx from a gateway model | upstream rate limit or outage | re-run that file once; a second failure replaces the model with the next candidate by the cell rule, recorded; never drop the cell |
  | 400 naming a field pi sent (`eager_input_streaming`, `prompt_cache_key`, `store`, `thinking`, an `anthropic-beta` name) | a pi default the cell refuses | stop; E1 to the `plan` agent with the request and answer: the fix is a `compat` rule (P5/P6 analogue of O6), written into the plan before any code change |
  | uc-pi-6 count stays 1 after `update --models` | pi 1.5.2 does not call `refreshModels` from the CLI | stop; E1 to the user with the counts (options: prove uc-pi-6 live through pi's interactive `/model` in a PTY run (recommended) / accept component + e2e proof for uc-pi-6, recorded as such) |
  | `Failed to load extension` | jiti cannot resolve the workspace alias or the self-reference | stop; E1 to the `plan` agent with pi's stderr (jiti resolution was run, real loading was not — Open questions) |

- **escalation**: E1
- **failure**: stage 8 blocked; step 8.5 still runs to restore the user's daemon.
- **returns**: n/a

### Step 8.4 — Prove the user's daemon state is untouched

- **runs in**: main session — live state
- **action**: `review`
- **target**: `{repo}/.cache` (names, modes, `proxy.yaml` checksum; never contents)
- **content**: compare `shasum -a 256 {repo}/.cache/proxy.yaml` and `stat -f '%Sp %N'` of `.cache`, `accounts.json`,
  `token.json` against step 0.4's output; the accounts file changes only through normal token renewal, so its checksum
  is not compared; `jq 'keys' {repo}/.cache/accounts.json` (top-level keys only) equals the step 0.4 output.
- **depends on**: 8.3
- **gates**: 1. checksums and modes equal; key list equal.
- **problems**: a difference → report it to the user with both outputs; never repair by hand.
- **escalation**: the user
- **failure**: reported, not repaired.
- **returns**: n/a

### Step 8.5 — Restore the user's daemon

- **runs in**: main session — live state
- **action**: `run`
- **target**: the daemon on `127.0.0.1:4141`
- **content**: `kill -INT <worktree daemon pid>` (normal exit path); ask the user to restart their daemon in `{repo}`
  (`bun run proxy serve`).
- **depends on**: 8.4 (and runs even when 8.3 failed)
- **gates**: 1. `ps -o command= -p <pid>` → empty; 2. after the user restarts: `curl -s http://127.0.0.1:4141/health` → ok, 7 providers; `lsof -a -p $(lsof -tiTCP:4141 -sTCP:LISTEN) -d cwd -Fn` → `n/Users/mavasbel/Dev/repos/devtools/accounts-proxy`.
- **problems**: the worktree daemon does not exit on SIGINT within 10 s → `kill -TERM`, recorded.
- **escalation**: the user
- **failure**: the user's daemon stays down; reported immediately.
- **returns**: n/a

### Step 8.6 — Stage 8 gate

- **runs in**: main session — stage gate
- **action**: `review`
- **target**: `{record}` § Live
- **content**: every cell has its five results or a recorded exemption; the granularity report passes; commit per rule 10.
- **depends on**: 8.1–8.5
- **gates**: 1. `{bun} scripts/gate/granularity-report.ts` → `GRANULARITY: PASS`; 2. § Live complete; 3. `git -C {worktree} status --porcelain` → empty after the commit.
- **problems**: a cell without results → reopen 8.3.
- **escalation**: E1
- **failure**: stage 9 does not start.
- **returns**: n/a

## Stage 9 — Final gate, integration, the user's pi

**Why.** The plan is complete only when the whole gate is green on the final tree and compared with the baseline
(`AGENTS.md` 3.8), and the original request — pi using the proxy — holds on the user's own pi.

**What.** The final gate in `{record}`; the branch integrated as the user chooses; the worktree removed; the user's pi
loading the extension; `{logs}` deleted.

**Enter gate.** Stage 8 gate green.

### Step 9.1 — Run the final gate

- **runs in**: main session — the final gate is never delegated
- **action**: `run`
- **target**: `{worktree}`
- **content**: `cd {worktree} && {bun} run verify > {logs}/final-verify.log 2>&1; echo "exit=$?"`
- **depends on**: stages 0–8
- **gates**:
  1. → the `GATE:` line; every step that passed in the baseline passes; every baseline failure is the same failure
     (no new failing step, no new failing test)
  2. unit and e2e coverage lines → `100%`, complete, `0 P5 deferrals`
  3. `granularity report` step → `GRANULARITY: PASS`
  4. typecheck, architecture law, docs lint → pass
- **problems**: a new failure → regression; reopen the owning step; never waive.
- **escalation**: the user, with both logs' summaries side by side
- **failure**: the plan is reported blocked.
- **returns**: n/a

### Step 9.2 — Close the plan loop

- **runs in**: main session — review of the whole plan
- **action**: `review`
- **target**: `{worktree}/docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`
- **content**: compare `git -C {worktree} diff --stat {base}..HEAD`, `{record}` and the final gate with the
  objective, the use-case table and the out-of-scope list.
- **depends on**: 9.1
- **gates**:
  1. every path of the architecture design §1–§6 appears in the diff; no path outside them except `bun.lock`,
     `docs/sessions/*`, the docs of stage 6
  2. `git -C {worktree} diff --stat {base}..HEAD -- docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md` → empty
  3. every step `[x]` in `{record}` with its gate output
- **problems**: a plan gap → `plan` agent; a build gap → reopen the step.
- **escalation**: the user, with the list of differences
- **failure**: the plan stays open.
- **returns**: n/a

### Step 9.3 — Record

- **runs in**: main session — the record is the launcher's duty
- **action**: `edit`
- **target**: `{record}`
- **content**: every step `[x]` with its commands and outputs; the baseline vs final gate table; the live table; the
  Bun drift note; the follow-up "pi recon parity (Linux)"; then commit per rule 10.
- **depends on**: 9.2
- **gates**: 1. no `[ ]` left except 9.4–9.6; 2. `git -C {worktree} status --porcelain` → empty.
- **problems**: a step without evidence stays `[ ]`; the plan is not reported done.
- **escalation**: the user
- **failure**: the plan stays open.
- **returns**: n/a

### Step 9.4 — Integrate

- **runs in**: main session — question to the user and an irreversible action
- **action**: `run`
- **target**: `{repo}` branch `main`
- **content**: ask with the `question` tool: merge into local `main` (recommended: local `main` is already 7 commits
  ahead of `origin/main` and unpushed) or push `feat-pi-compatibility` and open a pull request. Merge:
  `git -C {repo} merge --no-ff feat-pi-compatibility -m "Merge feat-pi-compatibility (plan 2026-11-15-23-52)"`, then
  `git -C {repo} worktree remove {worktree} && git -C {repo} worktree prune && git -C {repo} branch -d feat-pi-compatibility`.
  Pull request: `git -C {worktree} push -u origin feat-pi-compatibility`, PR opened by the user (outward publication
  stays under the user's control), worktree removed, branch kept. Pushing `main` is not part of this plan.
- **depends on**: 9.3
- **gates**:
  1. merge: `git -C {repo} log --oneline -1` → the merge commit; `git -C {repo} status --short` → the two pre-existing entries only
  2. `git -C {repo} worktree list` → no `feat-pi-compatibility`
- **problems**: merge conflict → stop; E1 to the user with `git -C {repo} diff --name-only --diff-filter=U`.
- **escalation**: the user
- **failure**: `git -C {repo} merge --abort`.
- **returns**: n/a

### Step 9.5 — Configure the user's pi

- **runs in**: main session — the user's own configuration and daemon
- **action**: `run`
- **target**: `/Users/mavasbel/.pi/agent/settings.json`
- **content**: requires the merged code in `{repo}` (after a pull request, this step waits until it is merged, recorded
  as pending). Ask the user to restart their daemon so it serves the new routes; copy
  `/Users/mavasbel/.pi/agent/settings.json` to `{logs}/settings.json.before`; run
  `pi install /Users/mavasbel/Dev/repos/devtools/accounts-proxy/apps/pi-extension`. Evidence goes to the record through
  a short documentation worktree `docs-pi-setup-record` created as step 0.1 does, one commit, merged with `--no-ff`
  and removed as step 9.4 does.
- **depends on**: 9.4
- **gates**:
  1. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4141/.well-known/pi` → `200`
  2. `grep -c 'apps/pi-extension' /Users/mavasbel/.pi/agent/settings.json` → `1` or more (pi stores the path relative
     to the agent directory: pi `dist/core/package-manager.js:1285-1293`)
  3. `pi --list-models ap-` → every available `ap-` provider
  4. `pi -p --no-session --model ap-claude/claude/claude-haiku-5-5 "Reply with exactly: OK"` → `OK`
  5. `test ! -e /Users/mavasbel/.pi/agent/models.json` → exit `0` (the extension needs no static file)
- **problems**: gate 3 empty → the daemon still runs pre-merge code; ask the user to restart it.
- **escalation**: the user
- **failure**: `cp {logs}/settings.json.before /Users/mavasbel/.pi/agent/settings.json` (exact restore; gate `cmp -s`).
- **returns**: n/a

### Step 9.6 — Clean up

- **runs in**: main session — the last step
- **action**: `delete`
- **target**: `{logs}`
- **content**: `rm -rf {logs}`: scratch logs, the catalog snapshot (metadata only) and the settings backup, after their
  summaries are in the record; nothing in the repository references them.
- **depends on**: 9.5
- **gates**: 1. `test ! -e {logs}` → exit `0`; 2. `git -C {repo} worktree list` → no worktree of this plan; 3. `git -C {repo} status --short` → the two pre-existing entries only.
- **problems**: none foreseen.
- **escalation**: the user
- **failure**: residue reported with its paths.
- **returns**: n/a
