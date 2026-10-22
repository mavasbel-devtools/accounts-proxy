# Recon & MITM capture — reconstructing client-indistinguishable adapters

Extends [plan v4](2026-10-11-22-11-completion-plan.md) and the [main plan](2026-10-06-00-23-inference-router-plan.md) §3
(the wire laws) with a new capability. Nothing earlier is replaced. Proposed 2026-10-19 20:04; status **PROPOSED**.

## 1. Goal

Today the proxy's wire laws are derived from **vendored plugin source** and from **our own** outbound traffic
(`RecordingTransport`). We have never observed what the real clients (`claude`, `opencode`, `codex`, `Antigravity`)
actually put on the wire. That is the gap this plan closes.

Deliverable: a repeatable recon facility that

1. captures real client ⇄ upstream traffic (requests, responses, both header sets, stream framing and timing),
2. stores it as redacted, committed evidence,
3. normalizes and diffs it against our adapters,
4. drives adapter reconstruction until our bytes are indistinguishable from the client's.

### 1.1 Definition of "indistinguishable"

For a given (client, cell, scenario), after canonicalization the proxy's upstream exchange must equal the client's.

| Level | Assertion |
|---|---|
| **L1 — bytes** | Same method, URL, HTTP version, header names, header order, header values, body bytes. |
| **L2 — stream** | Same SSE event sequence and frame boundaries (timing excluded). |
| **L3 — semantics** | Same decoded answer, same status, same error shape. |

Canonicalization is the **only** permitted difference. It may rewrite exactly:

- credential values (`authorization`, `x-api-key`, cookies, tokens) → shape-preserving placeholder;
- volatile identifiers (request ids, session ids, UUIDs, timestamps, nonces) → typed placeholder;
- `content-length`, `host`, `date`, `connection` → recomputed/allowed-to-differ;
- JSON object key order → sorted (arrays keep order);
- response `request-id` echo values → placeholder.

Everything else — including a header that is **absent** in the client and present in ours — is a failure. The gate
reports the diff, never silently normalizes it away.

## 2. Starting point (measured 2026-10-19 20:04)

| Subject | State |
|---|---|
| mitmproxy | `mitmdump` **12.2.3** on PATH |
| Claude Code | **2.1.304** (`~/.local/share/claude/versions/2.1.304`) |
| opencode | **2.0.32** |
| Codex CLI | **0.163.0**, `~/.codex/packages/standalone/current/bin/codex` → `releases/0.163.0-x86_64-unknown-linux-musl`, symlinked at `~/.local/bin/codex` |
| Antigravity IDE | **1.107.0** (Electron), `/home/mavasbel/Downloads/Antigravity IDE`; `resources/app/out/main.js` references `daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com`, `HTTPS_PROXY`, `rejectUnauthorized` |

Reusable assets already in the repo:

| Asset | Path | Use here |
|---|---|---|
| Recording decorator | `scripts/evidence/live/recording-transport.ts` | plane B capture |
| Redactor + token prefixes | `scripts/evidence/live/redact.ts` | shared redaction rules |
| Replay upstreams | `tests/support/e2e/upstreams.ts` | replay the goldens in e2e |
| Live matrix | `scripts/evidence/live/l1-live-matrix.ts` | plane C, scenarios to extend |
| Test seams | `ACCOUNTS_PROXY_TEST_UPSTREAM_*` | hermetic replay |
| Architecture gate | `tests/arch/architecture.test.ts` | constrains where TS lives |
| Docs-in-step | `apps/proxy/tests/unit/docs-in-step.test.ts` | keeps references honest |

## 3. Capture planes and topology

| Plane | Exchange | Instrument |
|---|---|---|
| **A** | real client → real upstream | TLS MITM (primary) or base-URL redirect (fallback) |
| **B** | proxy → real upstream | `RecordingTransport` |
| **C** | real client → proxy | live matrix / daemon with temp home |

A is the golden. B must become equal to A. C proves the client still behaves normally when it talks to us.

```
plane A:  client ──TLS──▶ mitm (dedicated CA) ──TLS──▶ upstream
plane B:  client ──▶ proxy ──(RecordingTransport)──▶ upstream
plane C:  client ──▶ proxy (temp ACCOUNTS_PROXY_HOME)
```

MITM is preferred over redirect because redirects change client behaviour: a non-default origin can alter or drop
headers. Redirect is the fallback where a client refuses a proxy, and every redirect capture is marked as such in
`index.json` so it is never compared as if it were a MITM capture.

## 4. Per-client capture mechanics

Each row is an **R0 hypothesis to be verified**, not a claim.

| Client | Isolation | Proxy | CA trust | Fallback |
|---|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR`, `HOME` temp | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY=127.0.0.1,localhost` | `NODE_EXTRA_CA_CERTS=<run ca.pem>` (Node) | `ANTHROPIC_BASE_URL` |
| opencode | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS` (Bun) | provider `baseURL` in `opencode.json` |
| Codex CLI | `CODEX_HOME` | `HTTPS_PROXY` (reqwest) | `SSL_CERT_FILE=<ca.pem>` (rustls) | `model_providers.<id>.base_url` |
| Antigravity | `--user-data-dir=<tmp>`, `--extensions-dir=<tmp>` | `HTTPS_PROXY` + VS Code `http.proxy` setting | `NODE_EXTRA_CA_CERTS` (Node side); Chromium side needs `--ignore-certificate-errors` or NSS import | settings `http.proxy`, `http.proxyStrictSSL=false`; last resort: language-server config |

Anti-goals: no system-wide CA install, no `update-ca-certificates`, no changes to the user's real config dirs, no
touching of the plugin repositories or installed plugin files (AGENTS.md §4).

## 5. Directory structure

```
scripts/recon/                        # TS harness; inside the arch gate's scanned scope, aliases only
├── README.md                         # how to run a capture session
├── cli.ts                            # recon run|list|diff|promote|parity|capability
├── config.ts                         # paths, timeouts, caps (max requests, delay, free-model policy)
├── clients/
│   ├── client.ts                     # abstract ReconClient (IoC): name, version(), prepare(), env(), scenarios()
│   ├── claude.ts                     # Claude Code adapter
│   ├── opencode.ts                   # opencode adapter (all four dialects)
│   ├── codex.ts                      # Codex CLI adapter
│   └── antigravity.ts                # Antigravity IDE adapter
├── mitm/
│   ├── requirements.lock             # mitmproxy==12.2.3 (pinned, uv-generated)
│   ├── recon_addon.py                # tagging, capture, SSE chunk timing, redact, write
│   ├── redact.py                     # reads shared/redaction.json; mirrors TS Redactor semantics
│   ├── sse.py                        # frame splitter + per-frame arrival time
│   ├── ca.py                        # per-run CA under .state/ca, never ~/.mitmproxy
│   └── shared/redaction.json         # single source of truth: token prefixes, credential headers/fields
├── scenarios/
│   ├── schema.ts                     # scenario type + validator
│   ├── matrix.ts                     # axis expansion: OAT (all) + pairwise (interacting axes only)
│   ├── claude/*.yaml
│   ├── opencode/*.yaml
│   ├── codex/*.yaml
│   └── antigravity/*.yaml
├── store/
│   ├── run.ts                        # run dir, index.json, atomic writes, gitignore guard
│   ├── exchange.ts                   # exchange record type + schema validator
│   └── layout.ts                     # path derivation + listing
├── normalize/
│   ├── volatile.ts                   # placeholder rules (ids, timestamps, tokens)
│   ├── canon.ts                      # header order/duplicates, JSON key sort, SSE frame parsing
│   └── diff.ts                       # structural diff → gap report
├── promote.ts                        # reviewed capture → golden fixture
├── parity.ts                         # golden → real adapter → compare (the gate)
└── tests/{unit,component,live,e2e}/
```

```
tests/fixtures/captures/recon/        # committed evidence, redacted
└── <client>/<cell>/<YYYYMMDD-HHMM>/
    ├── index.json                    # client version, OS, mitm version, scenario list, capture mode
    └── <scenario>/
        ├── 01-request.json
        ├── 01-response.json
        └── 01-response.sse.jsonl     # only for streamed answers

tests/fixtures/captures/golden/       # promoted + normalized; the only thing tests assert on
└── <client>/<cell>/<scenario>.json

docs/reference/                       # dated findings
├── <date>-recon-capability-matrix.md
├── <date>-recon-<client>-gap-report.md
└── <date>-recon-<client>-runbook.md
```

Gitignored: `scripts/recon/mitm/.venv/`, `scripts/recon/.state/` (CA private key, scratch), any `*.flow`.

## 6. Capture record

One JSON file per request and one per response, joined by `seq`.

```jsonc
// 01-request.json
{
  "schema": "recon-request/1",
  "run": "claude/20261019-2010",
  "client": "claude-code", "clientVersion": "2.1.304",
  "cell": "claude", "scenario": "i02-stream",
  "seq": 1, "atMs": 0,
  "mode": "mitm",                      // or "redirect"
  "method": "POST", "url": "https://api.anthropic.com/v1/messages?beta=true",
  "httpVersion": "HTTP/2",
  "headers": [["accept","application/json"], ["anthropic-beta","..."], ...],  // order + duplicates preserved
  "bodyEncoding": "utf8",
  "body": "{\n  \"model\": ..."
}
```

```jsonc
// 01-response.json
{
  "schema": "recon-response/1",
  "seq": 1, "status": 200, "httpVersion": "HTTP/2",
  "headers": [["content-type","text/event-stream"], ...],
  "headersAtMs": 143,
  "bodyEncoding": "utf8", "body": "...",           // non-stream
  "chunks": [{"atMs": 143, "bytes": 187, "text": "event: message_start\ndata: {...}\n\n"}],  // stream
  "doneAtMs": 2841,
  "redactions": [{"where":"header","name":"authorization","rule":"credential-header"}],
  "secretScan": "clean"
}
```

Rules:

- Headers are arrays of pairs, never objects: order and duplicates carry meaning.
- Bodies keep the **exact bytes** (UTF-8; `base64` when binary), so field order and whitespace survive.
- Streamed bodies keep per-frame arrival times: they are the proof of incremental streaming and the source of the
  chunk-boundary law.
- A capture with `secretScan != "clean"` is refused at write time; the redactor runs **before** anything touches disk.
- `index.json` pins the client version; a golden is only valid for that version family and is re-checked on bump.

## 7. Scenario matrix

### 7.1 Axes

| Axis | Levels |
|---|---|
| transport | non-stream, stream, stream-abort, HTTP/1.1, HTTP/2 |
| thinking | absent, `disabled`, enabled+budget, adaptive, mid-session effort change |
| tools | none, single, parallel, tool-result loop, orphan result, MCP/JSON-Schema tools |
| content | text, image, PDF, long context, unicode/emoji |
| caching | none, `cache_control` explicit, implicit |
| envelope | system prompt variants, `metadata.user_id`, session id, betas, prefill/trailing assistant |
| failure | 200, 400, 401, 429 + `retry-after`, 500, timeout, connection reset |
| compression | identity, gzip, br |

Expansion: **all one-factor-at-a-time** scenarios (the evidence base) plus **pairwise** combinations only for axes
known to interact (thinking × transport, tools × stream, failure × retry). The matrix is generated, not hand-written;
every generated id is stable and cites its axis values in `index.json`.

### 7.2 Per-client coverage

| Client | Cell(s) | Control plane | Inference scenarios |
|---|---|---|---|
| Claude Code | `claude` | login, refresh, models, quota | all axes except Gemini-only |
| opencode | `opencode`, `opencode-go`, `openai` (its ChatGPT flow) | login/refresh per auth, models, quota | all four dialects |
| Codex CLI | `openai` | login (ChatGPT), refresh, models | Responses-specific axes |
| Antigravity | `antigravity` | login, refresh, models, quota | Gemini cell: function calling, thoughtSignature, schema keywords |

### 7.3 Request budget

Per run: hard caps in `config.ts` (default 200 requests, 2 s spacing, free models first). Every scenario declares
its estimated cost and the run aborts on the cap. Live captures run with `ACCOUNTS_PROXY_LIVE=1` like every other
live script.

## 8. Phases

| Phase | Work | Exit criterion |
|---|---|---|
| **R0 — capability** | One tiny request per client through the MITM (health/model list). Record which env/setting makes each client trust the CA. | `recon-capability-matrix.md`: every client marked capturable (mitm / redirect / not yet), with the exact invocation |
| **R1 — core** | `store/`, `mitm/recon_addon.py`, CA lifecycle, redaction + scan, `index.json`, atomic writes, gitignore guard | A synthetic request through the addon produces a valid, redacted, committed-shape capture |
| **R2 — harness** | `clients/*`, `config.ts`, scenario schema + generator, isolation homes, start/stop, cleanup + restore check | `bun run recon run --client=claude --scenario=i01-plain` reproduces a capture deterministically; user config byte-unchanged afterwards |
| **R3 — control plane** | Login/refresh/models/quota per client | Each client's auth and control exchanges captured, including refresh rotation |
| **R4 — inference matrix** | Batched capture runs per client/cell, abort/reset and error scenarios included | Matrix complete or explicitly documented as unsupported per cell |
| **R5 — normalize + diff** | `canon.ts`, `volatile.ts`, `diff.ts`; baseline gap report per cell | Gap report lists every difference with severity, each traceable to a capture id |
| **R6 — closure** | Rule-by-rule adapter fixes, each citing a capture; goldens promoted; `parity.ts` green | L1+L2 parity for every captured scenario; `recon:parity` in `verify` |
| **R7 — maintenance** | Version-bump procedure: re-capture, diff goldens, regenerate matrix | Documented runbook; a bump produces a reviewable diff, not a silent drift |

## 9. From capture to adapter

1. **Capture** (A) with the redacted record above.
2. **Extract** a canonical envelope per cell: header set + order, body fields, defaults, omissions.
3. **Diff** against plane B for the same logical request. Output: `{field, client, ours, severity}`.
4. **Rule**: one gap → one rule in the provider's domain code, citing the capture path (evidence-only law).
5. **Parity test**: replay the golden through the real adapter under `RecordingTransport`, canonicalize both,
   assert equality. Failures name the field.
6. **Promotion**: only reviewed, minimal captures become goldens; the raw run stays as provenance.

This keeps the existing law intact: `scripts/evidence/live/*` continues to produce plane B evidence, this facility
produces plane A truth, and the two meet in `parity.ts`.

## 10. Safety and hygiene

| Concern | Control |
|---|---|
| Secrets | redact before write; `shared/redaction.json` is the single source; secret scan refuses the file |
| Credentials on disk | captures contain none; accounts stay in the existing 0600 stores |
| User state | every client runs under a temp HOME/config; a post-run byte-comparison proves the real files unchanged |
| Privilege | no system CA store, no sudo, no proxy on non-loopback interfaces |
| Cost | free models first, hard request cap, spacing, abort on cap |
| ToS | user's own subscriptions only; nothing is faked or replayed against a third party |
| Large payloads | image/PDF bodies stored base64 with a size cap; oversize bodies replaced by digest + a note, never silently |
| Toxicity of captures | no `.flow` files, no raw un-redacted bodies, no credentials in git |

## 11. Integration with the gate

- New scripts: `recon` (run/list/diff/promote) and `recon:parity`.
- `recon:parity` starts **non-blocking** in `verify`; it becomes blocking once the first cell is green (R6).
- TS under `scripts/recon/` follows the alias rule (`@accounts-proxy/scripts/recon/...`); Python is outside the
  arch gate (it only scans `.ts`).
- `docs-in-step` gains a check that every provider reference's wire-law citation resolves to an existing capture.
- `docs/reference` gets the capability matrix, per-client runbooks and gap reports.

## 12. Risks

| Risk | Mitigation |
|---|---|
| A client pins certificates or ignores the proxy (Antigravity Chromium side, Codex rustls) | R0 decides per client; redirect fallback; document the limitation instead of faking it |
| Client version drift invalidates goldens | version stamped in every record; R7 refresh procedure |
| Captures leak secrets | redact-before-write + scan + gitignore + review |
| Matrix explodes in cost/time | OAT + pairwise only; hard caps; free models |
| "Indistinguishable" becomes a moving target | the three levels are explicit; the gate reports, it never hides |
| Antigravity runs from `~/Downloads` (unusual install root) | reference it by absolute path in the client adapter; do not require installation elsewhere |

## 13. Decisions taken / open

Taken from the user's 2026-10-19 message: Codex is installed (0.163.0) and used as the real `openai` reference;
Antigravity is used from `/home/mavasbel/Downloads/Antigravity IDE` (1.107.0).

Open, with recommended defaults:

1. Harness location — `scripts/recon/` *(recommended: alias-clean, already inside the arch gate)*.
2. Matrix breadth — OAT everywhere + pairwise on interacting axes *(recommended; full Cartesian is cost-prohibitive)*.
3. Antigravity Chromium-side trust — per-app `--ignore-certificate-errors` vs a NSS import *(recommended: per-app flag
   first; NSS only if the flag does not cover the request path)*.

## 14. R0 results (2026-10-19 20:22)

Measured; full evidence in
[R0 capability matrix](../reference/2026-10-19-20-24-r0-recon-capability-matrix.md) and
`tests/fixtures/captures/recon/*/*/20261019-2022/`.

| Client | Interception | CA trust | Outcome |
|---|---|---|---|
| opencode 2.0.32 | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS` | capturable, 0 TLS failures |
| Antigravity 1.107.0 | `--proxy-server` + `HTTPS_PROXY` | `--ignore-certificate-errors` (Chromium), `NODE_EXTRA_CA_CERTS` (Node), `SSL_CERT_FILE` (Go LS) | capturable; Go LS trust not yet proven with auth |
| Claude Code 2.1.304 | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS` | capturable, 0 TLS failures |
| Codex 0.163.0 | `HTTPS_PROXY` | `SSL_CERT_FILE` | capturable for HTTP; WebSocket frames missing |

Plan changes forced by R0, applied to R1/R2:

- **R1 adds WebSocket capture.** Codex opens `wss://api.openai.com/v1/responses` before falling back to POST; an
  HTTP-only addon is blind to the primary path.
- **R2 isolation must override `HOME`, not only `--user-data-dir`** for Antigravity (auth and `~/.gemini/antigravity-ide`
  follow `HOME`), and each isolated home needs one interactive login because auth does not survive a copied
  user-data dir.
- **R2 must seed credentials without copying refresh tokens** for subscription clients (Claude Code rotates refresh
  tokens; old ones become `invalid_grant`), so auth seeding is either an interactive login or an explicitly approved
  read-only reuse.
- Antigravity's Go language server needs `SSL_CERT_FILE`; `NODE_EXTRA_CA_CERTS` alone leaves
  `daily-cloudcode-pa.googleapis.com` with `bad certificate` alerts. This is an R0 follow-up to confirm signed-in,
  not a settled law.
- `--ignore-certificate-errors` is not sufficient on its own for every Electron child process; the per-client matrix
  above is the authoritative combination.

## 15. Amendment — full isolation (2026-10-19 22:01)

User decision: complete isolation is required for **all four** clients before any capture work continues. Implemented
and measured; the record is
[2026-10-19-22-01-recon-full-isolation.md](../reference/2026-10-19-22-01-recon-full-isolation.md).

Acceptance command: `bun scripts/recon/cli.ts isolation`.

| Client | Probe | Guard | Exit | Result |
|---|---|---|---|---|
| opencode 2.0.32 | clean | unchanged | 0 | isolated |
| Antigravity 1.107.0 | clean | unchanged | launched, stopped at 30 s | isolated; 0 TLS failures after selective interception |
| Claude Code 2.1.304 | clean | unchanged | 0 | isolated |
| Codex 0.163.0 | clean | unchanged | 0 | isolated |

What changed in the facility:

1. **Private identity.** Each profile owns `/etc/machine-id`, `/etc/hostname`, `/etc/passwd`, `/etc/group` and
   `USER=recon`. Before this, Antigravity's language server reported `unleash-instanceid: mavasbel-mk15`; it now
   reports `recon-sandbox-<12 hex>`. Consequence for R4: that header is a canonicalization field, and no adapter rule
   may send the operator's identity upstream.
2. **Private X server.** Xvfb on a free display (`-ac`, `-nolisten tcp`) replaces `xvfb-run`; only
   `/tmp/.X11-unix` is bound, after the `/tmp` tmpfs, so the socket is not hidden by mount order.
3. **Browser-opener stub.** `/recon-bin/xdg-open` records the URL in the run and never reaches the operator's browser;
   the OAuth callback still works because the network namespace is shared.
4. **Complete guard sets.** All observed state directories per client, plus the operator's keyring and NSS stores.
   A path that changes after the client exits is classified `host-busy`, not a leak.
5. **Environment from the binaries.** `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`/`OPENCODE_DISABLE_AUTOUPDATE`,
   `CODEX_HOME`/`CODEX_CA_CERTIFICATE`; Antigravity keeps default XDG paths, explicit user-data/extensions/cache/crash
   dirs, `--disable-quic` and `--ignore-certificate-errors`.
6. **Run hygiene.** mitmproxy writes `mitm.log` per run (TLS handshake failures never become flows); bwrap starts with
   the run directory as cwd so Electron core dumps land in the run. Three core dumps from R0 (46 MB + 21 MB real,
   sparse) were removed from the repository root.
7. **Selective interception for Antigravity.** Chromium rejects mitmproxy's per-host leaf in some network contexts
   (measured: updater, telemetry, `main.vscode-cdn.net`, `redirector.gvt1.com`), and neither
   `--ignore-certificate-errors` nor an SPKI pin of the CA covers it. The addon now intercepts only the language
   server's API hosts and tunnels the rest with the real certificate: 8 handshake failures → 0 on an identical launch,
   and the login UI is never MITM'd. R1 must apply the same per-host policy to any GUI client.
8. **Only this run's display socket is mounted.** The whole `/tmp/.X11-unix` was bound at first; the sandbox could
   then reach the operator's X0/X1. It now binds `X<N>` only, and the probe asserts every other display socket is
   absent.

Open for R4, not decided here:

- Codex 0.163.0 logs in with `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, `originator=codex_cli_rs`. That is the legacy
  Codex identity, while the router's `openai` provider emulates opencode's sanctioned `agent_name_hint` flow. The
  capture will show which identity the target cell must reproduce; this is a rule decision for R4.
- Antigravity's auto-updater and VS Code telemetry still run through the proxy (updater answered 204 in the measured
  run; telemetry posts to `browser.events.data.microsoft.com`). Neither touches the LLM cells; R1 decides whether the
  addon drops them from the promoted corpus.

## 16. Amendment — R1 capture core (2026-10-20 00:00)

R1 is complete. Record: [2026-10-20-00-00-recon-capture-pipeline.md](../reference/2026-10-20-00-00-recon-capture-pipeline.md).

Exit criterion met: a synthetic request through the addon produces a valid, redacted, committed-shape capture, and the
same addon inside a real mitmdump records a real SSE exchange with arrival timing.

Delivered:

| Item | State |
|---|---|
| Record schema | `recon-request/1`, `recon-response/1`, `recon-websocket/1`, `recon-error/1`, `recon-index/1` |
| Bodies | decoded bytes, UTF-8 or base64, atomic writes, 4 MiB cap with `truncated` flag |
| Streams | `responseheaders` streaming; per-chunk `{atMs, bytes, text}`; `headersAtMs`/`doneAtMs`; gzip/deflate/br decoded for the record only |
| WebSocket | every frame with direction, opcode, timestamp; record rewritten per frame, `complete` on close |
| Redaction | `shared/redaction.json`, shared with `scripts/evidence/live/redact.ts`; scan **refuses** a body that still matches |
| Noise | updater/telemetry/CDN flows recorded with `noise: true` (decision below) |
| CA lifecycle | per-run confdir and CA, unchanged from R0 |
| Tests | 38-check synthetic self-check; 3 Bun tests including a real mitmdump end-to-end |

Measured: real Antigravity run recorded 11 request/response pairs with bodies (largest 368 845 B), 0 TLS handshake
failures, index counts `11/11/0`, isolation `clean`, guard `unchanged`.

Decisions taken here:

1. **Noise is labelled, not dropped.** The R0 open item asked whether the addon should drop updater and telemetry flows.
   It records them with `noise: true`; dropping belongs to promotion, so the raw run never loses evidence. Promotion
   filters on the flag.
2. **A redaction failure refuses the body, not the run.** The alternative — aborting the client — would hide the
   exchange that produced the leak. Status, headers and timings survive; the body does not, and the run counts it.
3. **One manifest for both redactors.** The live-evidence redactor now reads the recon manifest instead of keeping its
   own lists, so a new credential class is a one-line change.

Still open (moved to R2/R3):

- No signed-in inference exchange has been captured yet; all four profiles are signed out.
- Codex's WebSocket path is proven only synthetically until its profile is signed in.
- The per-host interception policy is applied to the GUI client (Antigravity); other GUI clients follow the same rule.

## 17. Amendment — R2 workflow capture and connection identity (2026-10-20 15:25)

R2 is complete. Record: [2026-10-20-00-00-recon-capture-pipeline.md](../reference/2026-10-20-00-00-recon-capture-pipeline.md).

Exit criterion met: a named workflow runs a real client inside its isolated profile, the capture records every flow with
bodies and timing, and `timeline.json` attributes each flow to the step that was open when it happened.

Delivered:

| Item | State |
|---|---|
| Workflow catalogue | 6 workflows × 4 clients (`bootstrap`, `turn`, `turn-tools`, `multiturn`, `abort`, `error`); an unsupported cell carries its measured reason |
| Drivers | `exec` steps (argv, timeout) and `gui` steps (launch, settle, `xdotool` prompt) run through the sandbox |
| Step markers | `steps.jsonl`, written by the driver on the same wall clock as every capture record |
| Timeline | `timeline.json`: steps → flows → connections, `summary`, `unmarked` for flows outside any step |
| Connection identity | `connections.json`: id, SNI, offered ALPN, **negotiated** ALPN/version/cipher, JA3 string and hash, raw ClientHello (base64) |
| Response identity | `recon-response/3` carries the request's URL and method, so a response names its endpoint without a join |
| Cancellation | `clientClosed` distinguishes a client hanging up after the provider's terminal event from a real abort |

Measured across the four clients (latest run per cell; `A/B` = requests/responses):

| Client | Workflow | Run | A/B | Streamed | SSE frames | Aborted | clientClosed | Errors |
|---|---|---|---|---|---|---|---|---|
| antigravity | bootstrap | 2026-10-20-15-11-13 | 3/3 | 0 | 0 | 0 | 0 | 0 |
| antigravity | turn | 2026-10-20-15-12-00 | 6/6 | 0 | 0 | 0 | 0 | 0 |
| claude | bootstrap | 2026-10-20-15-13-34 | 0/0 | 0 | 0 | 0 | 0 | 0 |
| claude | turn | 2026-10-20-15-22-34 | 2/1 | 0 | 0 | 0 | 0 | 1 |
| claude | multiturn | 2026-10-20-15-24-47 | 4/2 | 0 | 0 | 0 | 0 | 2 |
| claude | abort | 2026-10-20-15-22-37 | 2/1 | 0 | 0 | 0 | 0 | 1 |
| claude | error | 2026-10-20-15-22-40 | 2/1 | 0 | 0 | 0 | 0 | 1 |
| codex | bootstrap | 2026-10-20-15-13-55 | 0/0 | 0 | 0 | 0 | 0 | 0 |
| codex | turn | 2026-10-20-15-22-43 | 16/16 | 0 | 0 | 0 | 0 | 0 |
| codex | multiturn | 2026-10-20-15-14-20 | 16/16 | 0 | 0 | 0 | 0 | 0 |
| codex | abort | 2026-10-20-15-23-05 | 10/10 | 0 | 0 | 0 | 0 | 0 |
| codex | error | 2026-10-20-15-14-54 | 16/16 | 0 | 0 | 0 | 0 | 0 |
| opencode | bootstrap | 2026-10-20-15-24-23 | 0/0 | 0 | 0 | 0 | 0 | 0 |
| opencode | turn | 2026-10-20-15-22-23 | 3/3 | 2 | 55 | 0 | 1 | 0 |
| opencode | turn-tools | 2026-10-20-15-10-13 | 4/4 | 3 | 37 | 0 | 1 | 0 |
| opencode | multiturn | 2026-10-20-15-24-27 | 2/2 | 2 | 23 | 0 | 0 | 0 |
| opencode | abort | 2026-10-20-15-24-35 | 3/3 | 3 | 155 | 1 | 0 | 1 |
| opencode | error | 2026-10-20-15-11-09 | 0/0 | 0 | 0 | 0 | 0 | 0 |

Isolation was `probe clean` on every run. The guard reported `host-busy` only where a host process owns the changed
directory (this session's opencode, the Codex managed daemon), never `CHANGED`.

Three corrections forced by measurement:

1. **A client hanging up after the terminal event is not an abort.** The first R2 opencode run counted three aborted
   streams out of three, all of them complete: `[DONE]`/`message_stop` arrived and opencode closed the socket instead of
   waiting for the server. `clientClosed` (schema `/3`) now separates the two, and a close after a delivered response no
   longer writes an error record either (every signed-out 401 ended that way).
2. **URLs are redacted like bodies.** An OAuth callback and a signed link carry credentials in the query; the request and
   response records now run the same redactor over the URL (`where: "url"`).
3. **`host-busy` needs open descriptors, not just a process name.** The Codex managed daemon (`~/.codex/packages/...`,
   parent `systemd --user`) holds `logs_2.sqlite*` open and writes a 270 s config-reload log line. The process marker
   `/codex/packages/` never matched `.codex/packages/`, and the static marker cannot cover every install layout, so
   attribution now also asks `/proc/<pid>/fd`. That daemon, not the sandbox, explains the two `CHANGED` reports in the
   first R2 pass: its log rows in `logs_2.sqlite` are 270 s apart with `pid:912011`, and no sandboxed process ever
   connected to its socket (`ss -xp`, sampled through a run).

Still open (unchanged by R2):

- No signed-in inference exchange: all four profiles are signed out. Claude Code exits before `/v1/messages`; Codex
  records its control plane only; opencode records real streams because its free tier accepts a keyless request.
- Codex over WebSocket for real: it opens `wss://api.openai.com/v1/responses` only after sign-in.
- Antigravity `turn` drives the IDE with `xdotool`, so its capture is the control plane plus whatever the signed-in IDE
  does; the prompt step must be re-measured once its profile is signed in.

## 18. Amendment — login and profile persistence (2026-10-20 12:13)

R2 produced captures but no credentials: every profile was signed out, so three clients reached only their control
planes. This amendment makes a signed-in profile a first-class, repeatable step. Record:
[2026-10-20-12-13-recon-login-profiles.md](../reference/2026-10-20-12-13-recon-login-profiles.md).

### 18.1 opencode's managed-service port (measured blocker)

`bun scripts/recon/cli.ts run opencode --login` failed with
`Managed service port 49374 on 127.0.0.1 is already in use`. The port is a per-channel constant in opencode 2.1.1
(`latest` 49374, `local` 49375, otherwise a hash of the channel), used by `opencode serve --service` unless
`<config>/service.json` sets `service.port`. The operator's live opencode holds 49374 (`ss -ltnp`), and the sandbox
shares the network namespace, so no amount of file isolation could avoid the collision.

Fix, both layers measured: login uses `opencode auth login <target> --standalone` (private server, no managed port),
and every opencode run merges a freshly allocated free loopback port into the profile's `service.json`
(measured: `{"port": 45989}`).

### 18.2 Login is a run

`run <client> --login` uses the same pipeline as a capture (per-run CA, private display, sandbox, probe, guard) and
reuses the profile's stable home, so credentials are created once and persist. Each login writes
`profiles/<client>/login.json` (`recon-login/1`: version, timestamp, signed-in, marker path/size/sha256, opened URLs)
without storing a token. `profiles` and `logout` expose state; `logout` requires `--force`.

Per client: opencode `auth login --standalone`; Claude Code `auth login --claudeai`; Codex `login` (preflight on the
fixed loopback port 1455); Antigravity is driven on its private display.

### 18.3 Antigravity: the invisible button

Measured: sign-in is a system-browser flow (`Continue with Google` → `xdg-open` → Google URL with
`redirect_uri=http://localhost:<port>/oauth-callback`; 36815 and 37431 observed), so no VNC is needed. The only
invisible step is the button, so `loginClicks` clicks `(775,549)` (trust), `(761,501)` (migration cancel) and
`(639,292)` (Continue with Google), and the profile seeds `security.workspace.trust.enabled: false` so the trust modal
does not cover the welcome screen. Completion is read from the capture — a 200 to an OAuth token endpoint — never
assumed; an abandoned attempt fails with an explicit message.

### 18.4 Certificate: no patched bundle

The proposal to unbundle and repack Electron with the recon CA is rejected on evidence. The rejecting process is the
Go language server (R0: 14 TLS alerts for `daily-cloudcode-pa.googleapis.com` while Node calls to that host returned
200); its bundled `cert.pem` is a self-signed `CN=localhost, O=ENABLES HTTP2` file for local HTTP/2, not an upstream
trust anchor; `out/main.js` contains no HSTS or pinning directives; and Go reads `SSL_CERT_FILE`/`SSL_CERT_DIR`. The
sandbox therefore merges the run CA into a copy of the system bundle bound over `/etc/ssl/certs/ca-certificates.crt`,
and the probe asserts the CA body is present. A patched client is never used for capture: it would cease to be the
client whose bytes the goldens are supposed to record.

### 18.5 Measured state and what remains

All four profiles are still signed out; each needs one interactive login (`run <client> --login`), then the first
signed-in inference cell per client, then Codex's WebSocket cell. `isolation` reports `clean`/`unchanged` for all four
and `bun run verify` passes (762 unit, 225 e2e, 100% coverage, docs lint).

## 19. Amendment — signed-in captures for three clients, identity redaction, runner robustness (2026-10-21 20:05)

§18.5 is superseded for Claude Code and Antigravity: both now have signed-in captures. Codex remains deferred by the
operator. Records: [login record §9](../reference/2026-10-20-12-13-recon-login-profiles.md#9-signed-in-state-and-the-antigravity-driver-2026-10-21)
and [capture record §8](../reference/2026-10-20-00-00-recon-capture-pipeline.md#8-identity-redaction-and-evidence-checks-2026-10-21).

### 19.1 State per client

| Client | Signed in | Captured signed-in workflows |
|---|---|---|
| opencode 2.1.1 | yes, persists across runs | bootstrap, turn, turn-tools, multiturn, abort, error |
| Claude Code 2.1.304 | yes, persists across runs | turn, multiturn, turn-tools, abort, error; `bootstrap` declared unsupported (no start-up-only invocation; its start-up traffic heads every run) |
| Antigravity 1.107.0 | only for the life of the process | login + turn + multiturn + tool loop in one run (`2026-10-21-23-59-49-login`) |
| Codex 0.163.0 | no | deferred |

### 19.2 Antigravity cannot resume a login in the sandbox

Measured on every relaunch: the next start logs `Auth state changed to: signedOut`, the language server logs
`state syncing error: key not found`, and the model picker offers `No models available`. The keyring, the
`state.vscdb` workbench keys and a window-close teardown are all present; no `antigravityUnifiedStateSync.*` topic is
ever written. A recording therefore costs one consent, and `run antigravity --login --fresh --prompt=… --prompt=…`
takes every turn in the process that signed in. Root cause not established; it is the open REA item.

### 19.3 Rules added

- A workflow names the request it exists to produce (`expects`; per client `turnRequest`); a run without it exits 1
  however many other flows it recorded (measured: a turn with Send disabled recorded 350 start-up flows and exited 0).
- A login given prompts is held to the same rule (`missingTurn`).
- A failed login is recorded in `run.json` (`loginError`) instead of throwing before the record is written.
- `SIGINT`/`SIGTERM` reach the run's cleanup (measured: four orphaned `mitmdump`/`Xvfb` pairs before; 0 after, 33 s).
- One run per profile (profile lock).
- `RECON_DNS_SERVERS` names the resolver mitmdump uses upstream; the host's configured resolver was unreachable.
- Identity is redacted like a secret, from the same manifest: account fields, nested JSON strings and Claude's
  organisation UUID in URL paths.

### 19.4 Model lists: the clients do not call what the router calls

Across 27 signed-in runs, Claude Code 2.1.304 never called `GET /v1/models`; its model list comes from
`GET /api/claude_cli/bootstrap` and `GET /api/organizations/<org>/model_selector/cc`. The router's Claude catalog calls
`/v1/models` with the OAuth token, a request the real client does not make. opencode fetches
`models.opencode.ai/api.json` and `console/api/v2/config` once per start (22 and 11 times in 34 runs). Antigravity
calls `fetchAvailableModels`, `loadCodeAssist` and `listExperiments` repeatedly (33, 45 and 43 times in 87 runs).
These are the first entries of the R5 gap report.

### 19.5 Next

R3 (promote reviewed goldens), R4 (canonicalise and diff the router's outbound calls against them), R5 (gap report,
one rule per gap, each citing one capture id) for opencode, Claude Code and Antigravity.

## 20. Amendment — R5 parity tool and first gap report (2026-10-21 20:44)

User decision 2026-10-21 (option A): every call the proxy makes must be one the client makes, in the client's shape
and cadence; the clients' telemetry and feature-flag traffic is not generated. Record:
[2026-10-21-20-44-recon-gap-report.md](../reference/2026-10-21-20-44-recon-gap-report.md).

### 20.1 What was built

`bun scripts/recon/cli.ts parity <run-dir> <seq>...` replays captured client requests through a signed-in proxy daemon
(the e2e harness; no provider is contacted) and records the proxy's outbound requests with a TCP tap, so header order
and case survive. `scripts/recon/parity/`: `canon.ts` (canonical form; the planned `volatile.ts` is its masking half),
`diff.ts` (difference kinds, array alignment), `tap.ts` (wire tap and HTTP/1.1 parser), `cells.ts` (client request →
proxy request, per client), `compare.ts` (driver and report). The captures of one conversation share one daemon, so
per-session state evolves as it did for the client.

### 20.2 First results

Claude Code 2.1.304: its own request is refused by the proxy (seven `anthropic-beta` values not proven for the model),
the proxy presents Claude Code 2.1.280 on Windows, six client headers are missing and one is extra, header case and
order differ, and when the client is Claude Code the proxy duplicates the billing and identity system blocks.
Antigravity 1.107.0: `os_type=windows`, tools merged into one entry, and Bun's transport headers and order; every
other envelope field, including the trajectory labels and step counter, is equal.

### 20.3 Next (R6)

One rule per gap, each citing its capture id, with an e2e test replaying the capture; `parity` re-run until each cell
reports no difference outside the documented transport residuals. opencode's parity cell and the TLS comparison are
still to be added.
