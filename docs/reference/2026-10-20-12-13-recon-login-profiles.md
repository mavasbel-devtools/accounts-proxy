# Recon login and profile persistence

Contract for turning a signed-out recon profile into a signed-in one, for all four reference clients, with the
measurements behind each rule. Plan: §17 (login amendment). Isolation record:
[2026-10-19-22-01-recon-full-isolation.md](2026-10-19-22-01-recon-full-isolation.md).

## 1. A login is a run

`bun scripts/recon/cli.ts run <client> --login [--target <id>] [--timeout <ms>] [--force]`

The login goes through the same pipeline as a capture: fingerprint, per-run CA, private display, bubblewrap sandbox,
mitmproxy, in-sandbox probe, guard. Credentials are written only by the client, only inside its profile:

```
~/.local/share/accounts-proxy/recon/profiles/<client>/home
```

That path is stable. Every later run of the client reuses it, so a login is performed once and stays valid until the
client's own tokens expire or are revoked. Nothing is exported, copied or snapshotted: Claude and OpenAI rotate refresh
tokens on renewal, and a copied token invalidates the original grant.

Each login writes `profiles/<client>/login.json` (no secrets):

| Field | Meaning |
|---|---|
| `schema` | `recon-login/1` |
| `client`, `version` | the exact binary that performed the grant |
| `at` | UTC timestamp |
| `signedIn` | whether a credential marker exists in the profile |
| `markers[]` | relative path, byte size and SHA-256 of each marker |
| `openUrls[]` | URLs the client asked the browser to open |
| `exitCode` | login process exit status |

opencode 2.1.1 does not write `auth.json`: `auth login` creates a row in the profile's `opencode.db` (`credential`,
`integration_id = 'opencode'`, `active = 1`) and logs `credential created ... type=oauth active=true`. The record's
`signedIn` therefore comes from a read-only SQLite probe of that table; `markers` is empty because no stable file
exists to hash. `run <client> --verify` asks the client itself (`opencode auth list` → `OpenCode Console  Default
stored`) and rewrites the sign-in fields of an existing record without touching its provenance.

`bun scripts/recon/cli.ts profiles` lists each profile's state, version and marker hash; `logout` removes the profile's
credential markers only when `--force` is given.

## 2. Per-client login

| Client | Command | Browser leg | Completion signal in the profile |
|---|---|---|---|
| opencode | `opencode auth login <target> --standalone` | printed URL, `xdg-open` stub records it | `.local/share/opencode/auth.json`; `opencode auth list` |
| Antigravity | launch the IDE and click "Continue with Google" | `xdg-open` stub records the Google URL | no marker: proven by a captured `oauth` token response, then by a real inference capture |
| Claude Code | `claude auth login --claudeai` | printed URL; loopback callback returns into the sandbox | `.claude/.credentials.json`; `claude auth status` → `loggedIn: true` |
| Codex | `codex login` | local server on `127.0.0.1:1455`, URL printed | `.codex/auth.json`; `codex login status` |

The sandbox shares the network namespace with the host, so a URL opened in the operator's browser reaches the client's
loopback listener. That sharing is deliberate: it is what lets a browser login work without weakening file or identity
isolation.

## 3. opencode: the managed-service port

opencode 2.1.1 hardcodes the port of its managed service per release channel. From the installed binary:

```js
function A(e){
  if (e === "latest" || e === "dev" || e === "beta" || e === "next") return 49374;
  if (e === "local") return 49375;
  return 10000 + parseInt(hash(channel).slice(0, 8), 16) % 50000;
}
```

`opencode auth login` starts `opencode serve --service`, which takes that constant unless `<config>/service.json` sets
`service.port`. Measured on this host:

| Fact | Evidence |
|---|---|
| 49374 is held by the operator's live opencode | `ss -ltnp` → `127.0.0.1:49374 opencode pid=2653406` |
| The sandbox inherits the network namespace | the failing run reported `EADDRINUSE` on 49374 |
| The profile had no override | no `service.json` under the profile |

Two layers fix it:

1. Login runs with `--standalone`, the documented flag that uses a private server instead of the background service.
2. Every opencode run allocates a free loopback port (`bind 127.0.0.1:0`, read, close) and merges `{"port": N}` into
   `<profile>/.config/opencode/service.json`, so any later background-service use is also off the operator's port.
   Measured: the first run after the fix wrote `{"port": 45989}`.

## 4. Antigravity: a GUI login on a private display

The sign-in button lives in an Electron window on an X server the operator cannot see. Three measured facts shape the
driver:

1. The welcome screen is covered by a workspace-trust dialog on a fresh profile. The profile's own
   `User/settings.json` now carries `security.workspace.trust.enabled: false`, which removes the modal instead of
   clicking it blind.
2. Sign-in is a system-browser flow, not an embedded one: `Continue with Google` calls the opener, and the stub records
   `https://accounts.google.com/o/oauth2/v2/auth?...&redirect_uri=http%3A%2F%2Flocalhost%3A<port>%2Foauth-callback`.
   Measured ports: 36815 and 37431 on two launches.
3. The remaining invisible step is the button itself, so `loginClicks` clicks it by coordinate after the launch delay:
   `(775,549)` trust dialog, `(761,501)` migration dialog cancel, `(639,292)` Continue with Google. A click whose dialog
   is absent lands on empty space. The coordinates are part of the version pin: 1.107.0 at 1280x800, re-measured on
   upgrade.

Completion is read from the capture, not guessed: a 200 response to an OAuth token endpoint means credentials were
issued. The driver then waits 3 s for the profile to be persisted and stops the app. Measured on an abandoned attempt
(no consent given): the URL was printed, no token response appeared, and the run failed with an explicit message rather
than reporting success.

No VNC is needed for this client. An earlier hypothesis that it might be is withdrawn: the sign-in is a browser flow.

## 5. The certificate question: patching the bundle is the wrong lever

The proposal was to unbundle the Electron app, add the recon CA to its certificate chains, repack, and use that patched
bundle. The evidence says it would not fix the failure and would damage the capture:

| Finding | Evidence |
|---|---|
| The rejecting process is the Go language server, not Electron | R0: 14 `ssl/tls alert bad certificate` for `daily-cloudcode-pa.googleapis.com` while Node calls to the same host returned 200 |
| Electron's stack is already covered | `--ignore-certificate-errors` (and the system bundle) are in the launch flags; no Electron TLS alert remains |
| The bundle's own `cert.pem` is unrelated to upstream trust | `subject=CN=localhost, O=ENABLES HTTP2, OU=bundled on purpose`, self-signed, valid 2026-04-18 → 2026-11-03 |
| HSTS is not involved | HSTS upgrades `http:` to `https:`; it cannot reject a certificate. `strict-transport-security` and `pin-sha256` do not occur in `out/main.js` (0 matches) |
| Go's trust inputs are environment variables | `SSL_CERT_FILE` / `SSL_CERT_DIR`; the sandbox binds `/recon-ca.pem` and sets both, plus `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO` |

So the sandbox now also merges the run CA into a copy of the system bundle and binds it over
`/etc/ssl/certs/ca-certificates.crt`; the in-sandbox probe asserts the CA body is present, so a stack that reads only
the platform store is covered too.

A patched client is **not** used for capture. The recon premise is that a capture records the shipped client's bytes;
a patched binary would prove the patched client's behaviour instead, and the version pin would be a lie. If a patched
build is ever needed to reach a hardcoded endpoint, it belongs in a scratch copy for diagnosis, never in a run that
produces a golden.

## 6. Measured state

| Client | Profile state at the time of writing | What is still needed |
|---|---|---|
| opencode 2.1.1 | **signed in** (2026-10-20 18:20 UTC, device flow, credential in `opencode.db`; `auth list` → `OpenCode Console  Default  stored`) | nothing; its six workflows now record signed-in inference |
| Antigravity 1.107.0 | signed out | `--login`, then consent in the operator's browser on the printed URL |
| Claude Code 2.1.304 | signed out | `--login`, then the printed URL |
| Codex 0.163.0 | signed out | `--login`, then the printed URL |

The isolation probe reports `clean` and the guard `unchanged` for all four with the login code in place
(`bun scripts/recon/cli.ts isolation`), and `bun run verify` passes with the new modules covered.

## 7. Residuals

- The login depends on the shared network namespace: the browser's loopback callback must reach the sandbox. This is
  the same residual as capture egress, stated in the isolation record.
- Antigravity's click coordinates are pinned to 1.107.0 at 1280x800 and must be re-measured on upgrade; a failed
  sequence fails the run with an explicit message instead of waiting out the timeout silently.
- opencode's login is a TUI: the integration must be selected by a human. Automation stops at launching it.
- A login URL is only valid while its run is waiting (state and loopback port are per-launch). Re-running `--login`
  issues a fresh URL.

## 8. Files

| File | Role |
|---|---|
| `scripts/recon/clients.ts` | login argv, targets, status command, GUI click sequence, signed-in probe |
| `scripts/recon/login.ts` | marker hashes, SQLite credential probe, `login.json` write/read/refresh |
| `scripts/recon/sandbox/ports.ts` | free loopback port for the profile's `service.port`, fixed-port preflight |
| `scripts/recon/sandbox/settings.ts` | merges one key into a VS Code-style `settings.json` without discarding other keys |
| `scripts/recon/run.ts` | `--login`/`--verify` modes, GUI driver, token-exchange detection, record update |
| `scripts/recon/cli.ts` | `run --login|--verify`, `profiles`, `logout`, live URL printing |
| `scripts/tests/unit/recon-login.test.ts` | ports, command substitution, records, SQLite probe, settings merge |

## 9. Signed-in state and the Antigravity driver (2026-10-21)

§4's click coordinates and its "waits 3 s, then stops the app" completion rule are superseded by this section; §6's
table is superseded by 9.1.

### 9.1 State

| Client | Profile | Evidence |
|---|---|---|
| opencode 2.1.1 | signed in, persists | §6 |
| Claude Code 2.1.304 | signed in, persists | signed-in `turn` → `POST /v1/messages?beta=true` 200; re-run `2026-10-22-02-04-42-workflow` without a login |
| Antigravity 1.107.0 | signed in for the life of one process | next launch `signedOut`; `ls-main.log`: `state syncing error: key not found` |
| Codex 0.163.0 | signed out | deferred by the operator |

### 9.2 What the Antigravity driver does now

| Step | Measured reason |
|---|---|
| `--fresh` renames `profiles/antigravity/home` to `home.<stamp>.bak` before launch | after onboarding, "Continue with Google" is gone; the title-bar "Log in" opens Settings → Account, whose "Sign In" never reached the browser opener |
| `loginButtons: ["?I trust the authors", "Continue with Google"]`, clicked by label over CDP, polled up to 180 s | coordinates missed when the window appeared before the UI; "Log in" as an alternative was clicked first on a fresh launch |
| Sign-in is read from `.antigravity/user-data/logs/*/auth.log` as well as `.config/Antigravity IDE/logs/*/auth.log` | with `--user-data-dir` the client logs only under the first; reading the second alone missed a completed login |
| Before each prompt: dismiss trust and migration dialogs, "Skip onboarding", else "Next", until `Message input` is visible (up to 2 min) | right after sign-in the window shows "Success, Continuing…" over a six-slide carousel |
| Pick a model if none is selected; type with `Input.insertText`; press the `Send message` control | synthetic key events left the input empty; Send stays disabled without a model |
| No keyboard fallback when CDP is available | blind typing pressed Return on the carousel and moved past the only slide with "Skip onboarding" |

### 9.3 The recording

Run `2026-10-21-23-59-49-login` (consent 18:23 local): exit 0, probe `clean`, guard `unchanged`, `missingTurn: false`.

| Seq | Model | Status | Contents |
|---|---|---|---|
| 3287 | `gemini-3.8-flash-high` | 200 | `user` |
| 3292 | `gemini-3.1-flash-lite` | 200 | `user` (a side call the client makes beside the turn) |
| 3306 | `gemini-3.8-flash-high` | 200 | `user, model, user` → one `functionCall` |
| 3313 | `gemini-3.8-flash-high` | 200 | `…, model[functionCall], model[functionResponse]` |
| 3343 | `gemini-3.8-flash-high` | 200 | seven contents: the whole history replayed |

How it was driven, stated plainly: after sign-in the run's own driver did not find the chat input (the carousel
defect fixed in 9.2), and its keyboard fallback advanced the carousel. The operator-side session skipped onboarding and
sent the three prompts over CDP inside the same live process. The traffic is the client's own; the turns were not
sent unattended. The earlier run `2026-10-21-07-17-32-login` holds the same sequence (seq 2103–2293) but no `run.json`,
because its login detection failed before the record was written (fixed: 9.2 and plan §19.3).

### 9.4 Residuals

- One consent per Antigravity recording until the state-sync persistence is understood.
- The unattended carousel walk (9.2, rows 4–6) is unit-tested but not yet proven by a run without operator help.
