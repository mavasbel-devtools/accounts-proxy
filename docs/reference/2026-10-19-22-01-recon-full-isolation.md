# Recon facility: full isolation for the four reference clients

Date: 2026-10-19 22:01 · Plan: [2026-10-19-20-04-recon-mitm-capture-plan.md](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md) · R0 matrix:
[2026-10-19-20-24-r0-recon-capability-matrix.md](2026-10-19-20-24-r0-recon-capability-matrix.md)

This record states the isolation contract of `scripts/recon/`, the measured result for each client, and the deviations
that isolation forces on the wire. Every claim below was produced on this machine on 2026-10-19; nothing is projected.

## 1. Contract

A client run is isolated when all six hold:

| # | Property | Mechanism | Proof |
|---|---|---|---|
| 1 | The operator's home is not mounted | bwrap's root is a private tmpfs; `/home` is an empty tmpfs; only the profile is bound, at `/home/recon` | in-sandbox probe: `test -e /home/<operator>` fails |
| 2 | No client state is writable on the host | the profile (`~/.local/share/accounts-proxy/recon/profiles/<client>`, mode 0700) is the only writable home | fingerprint of every real state directory before/after |
| 3 | The environment is the sandbox's alone | `--clearenv`, then only spec variables | unit test: first `--setenv` follows `--clearenv` |
| 4 | Identity is the profile's, not the operator's | private `/etc/machine-id`, `/etc/hostname`, `/etc/passwd`, `/etc/group`; `USER=recon` | in-sandbox probe: `id -un` = `recon`, `hostname` = `sandbox-<12 hex>`, machine id = profile's |
| 5 | No host session services are reachable | no `/run/user/<uid>` bind, no `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` inside the profile, keyring dirs guarded | probe: guarded paths absent, parents unwritable |
| 6 | Every TLS connection is the run's | per-run mitmproxy CA, bound at `/recon-ca.pem`; `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `CODEX_CA_CERTIFICATE` | mitm.log per run; captured flows |

Besides the six, each run gets its own X server (Xvfb on a free display, `-ac`, `-nolisten tcp`) for GUI clients, and a
browser-opener stub (`/recon-bin/xdg-open`) that records the URL into the run's `work/open-url.log` instead of
touching the operator's browser. The OAuth loopback listener stays on the shared network namespace, so the operator
opens the URL on the host and the callback still reaches the sandboxed client.

## 2. Per-client result

Command: `bun scripts/recon/cli.ts isolation` (each client launched for real inside its sandbox, 30 s bound).

| Client | Version | Probe | Guard | Exit | Captures |
|---|---|---|---|---|---|
| opencode | 2.0.32 | clean | unchanged | 0 | 0 (`--version`) |
| Antigravity IDE | 1.107.0 | clean | unchanged | launched, stopped at timeout | 4 |
| Claude Code | 2.1.304 | clean | unchanged | 0 | 0 (`--version`) |
| Codex CLI | 0.163.0 | clean | unchanged | 0 | 0 (`--version`) |

`opencode` is the only client whose real state directory is live during a run (the operator's session writes its 2 GB
database continuously). Two signals separate a leak from the operator's own activity: a path that also changes
**after** the client exited is `host-busy`, and a path owned by a client whose process is running on the host
(`/proc/<pid>/cmdline`, per-client `processMarker`) is `host-busy` too. Everything else is an unexplained change and
fails the run. The probe — which runs inside the namespace — remains the authoritative proof.

## 3. State the guard protects

| Client | Real paths | Profile paths (relative to `/home/recon`) |
|---|---|---|
| claude | `.claude`, `.claude.json`, `.claude.json.backup`, `.cache/claude`, `.local/state/claude` | `.claude` |
| opencode | `.config/opencode`, `.local/share/opencode`, `.local/state/opencode`, `.cache/opencode`, `.opencode` | same four under the profile |
| codex | `.codex`, `.config/codex`, `.cache/codex`, `.local/state/codex` | `.codex` |
| antigravity | `.gemini`, `.config/Antigravity IDE`, `.config/Antigravity`, `.antigravity-ide`, `.cache/Antigravity IDE`, `.cache/Antigravity`, `.config/gcloud` | `.gemini/*`, `.config/Antigravity IDE`, `.antigravity-ide/*`, `.cache/Antigravity IDE` |

Every client additionally guards the operator's identity stores: `~/.local/share/keyrings`, `~/.config/keyrings`,
`~/.pki/nssdb`.

## 4. Environment, from the installed binaries

| Client | Variables that redirect state | Evidence |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | string in the 2.1.304 binary |
| opencode | `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_AUTOUPDATE`, XDG dirs | strings in the 2.0.32 binary |
| codex | `CODEX_HOME`, `CODEX_CA_CERTIFICATE` | strings in the 0.163.0 binary |
| antigravity | `--user-data-dir`, `--extensions-dir`, `--disk-cache-dir`, `--crash-dumps-dir`, XDG dirs, `HOME` for `~/.gemini` | R0: auth lives in `~/.gemini/antigravity-ide`, which follows `HOME`, not the user-data dir |

## 5. Measured identity leak, and its fix

Before the identity binds, Antigravity's language server reported:

```
unleash-instanceid: mavasbel-mk15        # <operator user>-<host hostname>
```

After binding the private `passwd`, `group`, `hostname` and `machine-id`:

```
unleash-instanceid: recon-sandbox-61ac3947d2b8
```

This is a deliberate deviation from the real client: the wire now carries the sandbox's identity. Capture comparison
must canonicalize that header (R4), and no rule may copy the operator's identity back upstream.

## 6. Deviations that isolation forces

| Deviation | Why | Where recorded |
|---|---|---|
| Antigravity runs with `--no-sandbox` | Chromium's own sandbox cannot nest inside bwrap's user namespace | run command in `run.json` |
| Antigravity gets `--disable-quic` | HTTP/3 would bypass the recording proxy | same |
| Antigravity gets `--ignore-certificate-errors` | the Chromium network stack does not read `SSL_CERT_FILE`; the Go language server does | R0 matrix |
| Antigravity intercepts only the language server's API hosts | Chromium rejects the proxy's per-host leaf certificate in several contexts (`certificate unknown`) — measured on the updater, telemetry, `main.vscode-cdn.net` and `redirector.gvt1.com` — and its sign-in pages must keep working. Those hosts are tunnelled untouched; the API hosts (Cloud Code, `www/oauth2/sts/iamcredentials/aiplatform/businessaicode.googleapis.com`, `antigravity-unleash.goog`, `play.googleapis.com`) are intercepted | §6a |
| Hostname, machine id and account name are the sandbox's | property 4 | §5 |
| `xdg-open` is a recorder stub | the operator's browser profile must not be reachable | §1 |
| GUI clients are stopped at a timeout | they have no `--version` exit | `isolation` output |

### 6a. Selective interception for the GUI client

`--ignore-certificate-errors` and `--ignore-certificate-errors-spki-list=<CA>` were both measured insufficient: a
Chromium network context still answered `bad certificate` for the per-host leaf mitmproxy generates (the SPKI pin
matches a leaf, and the leaf differs per host). Since none of that traffic is LLM traffic, the addon now decides per
SNI in `tls_clienthello`: hosts matching `recon_intercept_hosts` are intercepted, everything else is tunnelled with the
real certificate. The Antigravity list is the language server's API surface, read from
`resources/app/extensions/antigravity/bin/language_server_linux_x64` and the R0 captures.

Measured effect on an identical 30 s launch: **8 client TLS handshake failures → 0**, and the capture set became the
target hosts only (`antigravity-unleash.goog`, `play.googleapis.com`). Login pages and telemetry never see the proxy CA.

## 7. Login procedure (per profile, once)

1. `bun scripts/recon/cli.ts run <client> --login`
2. The client prints a URL, and any browser it tries to open is recorded in the run's `work/open-url.log`.
3. Open that URL on the host. The loopback callback reaches the sandboxed client because the network namespace is
   shared; the tokens are written only inside the profile.
4. `bun scripts/recon/cli.ts profiles` shows the login state (`signed in`, `signed out`, or `profile-only` for
   Antigravity, which keeps no single documented credential file).
5. `bun scripts/recon/cli.ts reset <client> --yes` destroys one profile.

Measured on Codex 0.163.0: the login server started on `127.0.0.1:1455`, printed its authorize URL, the probe stayed
clean and the guard unchanged; no code was exchanged. The URL carries `client_id=app_EMoamEEZ73f0CkXaXp7hrann` and
`originator=codex_cli_rs` — the legacy Codex client identity, not the `agent_name_hint` flow the router's `openai`
provider emulates. Which identity the `openai` cell must reproduce is an R4 decision, recorded in the plan.

## 8. Known residuals

- **Shared network namespace.** Isolation is of state and identity, not of routing. A client that ignored
  `HTTPS_PROXY` would still reach the internet unproxied. `--disable-quic` closes the known Chromium path; every
  measured client honoured the proxy (R0). A routing-level proof needs a private netns with `pasta`/`slirp4netns`,
  which this host does not have (`pasta not found`, `slirp4netns not found`).
- **The proxy itself has no authentication.** It listens on an ephemeral loopback port for the duration of one run.
- **Crash dumps.** Electron's utility process dumped core twice during R0; the bwrap process now starts with the run
  directory as its cwd, so future cores land in the run, not in the repository. Two cores (46 MB and 21 MB of real
  data, sparse) were removed from the repository root.
