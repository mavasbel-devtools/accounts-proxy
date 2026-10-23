# Recon capture pipeline (R1–R2)

Plan: [2026-10-19-20-04-recon-mitm-capture-plan.md](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md) §6, §8, §16, §17
Phases: **R1 — capture core**, **R2 — workflow capture and connection identity**
Measured: 2026-10-20 15:25

## 1. What R1–R2 deliver

The capture addon records what a reference client actually sent and received, in a shape that can be compared
byte-for-byte with our own adapter output, and the driver labels the capture with the workflow step that produced it.

| File | Content |
|---|---|
| `<seq>-request.json` | method, URL, HTTP version, ordered header pairs, body |
| `<seq>-response.json` | request URL and method, status, ordered header pairs, body **or** per-chunk SSE text, `clientClosed` |
| `<seq>-websocket.json` | every WebSocket frame, direction, opcode, timestamp |
| `<seq>-error.json` | the failure mitmproxy saw (TLS alert, reset, unreachable host) |
| `connections.json` | one entry per client connection: SNI, ALPN offer and **negotiated** value, TLS version, cipher, JA3, raw ClientHello |
| `steps.jsonl` | driver step markers on the same wall clock as the records |
| `timeline.json` | steps → flows → connections, `summary`, and every flow no step covered |
| `index.json` | run identity, client version, cell, counts, redaction-manifest schema |

`seq` joins a request to its response. A WebSocket connection gets its own `seq` and a record rewritten atomically on
every frame, so a killed run still leaves the frames received so far. Schema versions: `recon-request/2`,
`recon-response/3`, `recon-websocket/2`, `recon-error/2`, `recon-connections/1`, `recon-timeline/1`, `recon-index/2`.

## 2. Contract

- **Headers are ordered pairs**, duplicates preserved (`[["x-duplicate","one"],["x-duplicate","two"]]`). An object
  would destroy both order and duplicates, which are part of what makes a client recognisable.
- **Bodies are the decoded bytes**: `bodyEncoding: "utf8"` keeps the exact text (field order and whitespace survive),
  `base64` is used when the bytes are not valid UTF-8. Nothing is parsed and re-serialised.
- **Streams keep arrival timing.** `responseheaders` switches `text/event-stream` responses to streaming; the callback
  records `{atMs, bytes, text}` per chunk and returns the chunk unchanged, so capture cannot alter client behaviour.
  `headersAtMs` and `doneAtMs` bracket the stream.
- **Compressed streams are decoded for the record.** The client still receives the compressed bytes; the capture
  decodes gzip/deflate/brotli incrementally so chunk boundaries reflect arrival, not compression framing.
- **Redaction runs before anything touches disk.** Credential headers keep only their scheme
  (`Bearer <REDACTED:authorization>`); credential JSON fields, query parameters and token prefixes are replaced in
  place without re-serialising the body.
- **A surviving secret refuses the body.** If the scan still finds a token prefix, a bearer token or a private-key
  marker, the record keeps status and headers, the body becomes `null`, `secretScan` says `refused`, and the run counts
  it. A capture never stores what the redactor could not prove clean.
- **Writes are atomic** (`.tmp` + `os.replace`).
- **Noise is labelled, never dropped.** Updater, telemetry and CDN hosts observed in R0 are recorded with
  `noise: true` so promotion can filter them without the capture having discarded evidence.
- **URLs are redacted like bodies.** An OAuth callback or a signed link carries credentials in the query, so the same
  rules run over the URL (`where: "url"`), not only over bodies and headers.
- **A client that hangs up after the terminal event is `clientClosed`, not aborted.** `message_stop`, `[DONE]`,
  `response.completed` or a non-null `finish_reason`/`finishReason` in the stream's tail means the provider finished;
  the client closing the socket afterwards is complete (`aborted: false`, `clientClosed: true`) and writes no error
  record. Only a stream without a terminal event is an abort, and it keeps every chunk received before the close.
- **Connections keep the negotiation, not just the offer.** `tls_clienthello` records SNI, offered ALPN, cipher and
  extension order plus the raw bytes (so a JA3 or any later fingerprint is reproducible offline);
  `tls_established_client` fills the negotiated ALPN, TLS version and cipher once the handshake answers.
- **No manifest, no capture.** `running()` refuses to start without `shared/redaction.json`; a misconfigured run fails
  loudly instead of recording credentials.

## 3. Single source of redaction

`scripts/recon/shared/redaction.json` holds credential headers, credential fields, query fields, token prefixes,
forbidden markers and the minimum token tail. Two readers:

- `scripts/recon/mitm/recon_addon.py` (Python, reads the file named by `recon_redaction`).
- `scripts/evidence/live/redact.ts` (its `CREDENTIAL_HEADERS`, `CREDENTIAL_FIELDS` and `TOKEN_PREFIXES` now come from
  `scripts/recon/shared/manifest.ts`, which validates the JSON at load).

The live-evidence redactor and the MITM capture therefore cannot drift apart. Adding a credential class is one edit.

## 4. Measurements

### 4.1 Addon contract, synthetic flows

`/usr/bin/python3 scripts/recon/mitm/selfcheck.py` — **73 checks pass**. Covers: ordered duplicate headers, credential
header keeping its scheme, JSON field redaction, query redaction, token-prefix redaction, URL redaction, byte-exact
body, SSE chunks with timing, a completed stream the client closed, a cancelled stream, gzip stream decoded for the
record and left untouched for the client, WebSocket text and binary frames, negotiated TLS parameters, refusal of a
private-key marker, error record, index counts, and refusal to run without a manifest.

### 4.2 Real mitmdump, real HTTP and SSE

`scripts/tests/unit/recon-capture.test.ts` starts mitmdump with the production `startMitm` wiring, proxies a local
origin through it, and asserts the files: two requests, two responses, an SSE body reassembled from chunks equal to
what the client received, `headersAtMs ≤ first chunk ≤ doneAtMs`, and **no** capture file containing the injected
`sk-ant-…` token. Three tests pass (manifest, selfcheck, mitmdump end-to-end).

### 4.3 Real client, real TLS and HTTP/2

`bun scripts/recon/cli.ts run antigravity --timeout=25000` in the isolated profile:

| Flow | Status | Captured body |
|---|---|---|
| `POST antigravity-unleash.goog/api/client/register` | 202 | request 578 B |
| `GET antigravity-unleash.goog/api/client/features` | 200 | response 368 845 B |
| `GET playwright*.azureedge.net/.../playwright-1.57.0-linux.zip` | 404 ×3 | 213 B each |
| `GET antigravity-ide-auto-updater-…/api/update` | 204 | empty |
| `GET main.vscode-cdn.net/extensions/chat.json` | 304 | `noise` |
| `POST browser.events.data.microsoft.com/OneCollector/1.0` | 401 ×2 | `noise`, 44 B |
| `POST play.googleapis.com/log` | 200 ×2 | 112 B |

Index: `requests 11, responses 11, websockets 0, refusals 0, truncated 0, noise 3`. `mitm.log`: **zero** TLS
handshake failures. Isolation probe `clean`, guard `unchanged`.

This is the first run where request and response bodies of a real client were recorded; the R0 addon stored only
method, URL, headers and byte counts (4 flows, no bodies).

### 4.4 Workflow runs (R2)

`bun scripts/recon/cli.ts workflow <client> <id>` runs the workflow inside the isolated profile and writes
`timeline.json` beside the captures. Latest run per cell (`A/B` = requests/responses):

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

All runs: isolation `probe clean`, guard `unchanged` or `host-busy` (never `CHANGED`). Claude's error column is the
abandoned telemetry batch (`POST /api/event_logging/v2/batch`, no response) — signed-out Claude Code makes no
inference call. Codex's flows are its control plane; it opens the Responses WebSocket only after sign-in.

### 4.5 Why a run can report `host-busy`

The Codex managed daemon (`.codex/packages/app-server-daemon/...`, parent `systemd --user`, started 2026-10-19 20:08)
holds `logs_2.sqlite*` open and appends a `codex_config::loader::layer_io` line every 270 s with `pid:912011`. Two
first-pass R2 runs coincided with that write and reported `CHANGED`. Evidence that it is the daemon, not the sandbox:
the rows in `logs_2.sqlite` are 270 s apart, the daemon's `wchar` grew while idle, `/proc/912011/fd` points at
`~/.codex/logs_2.sqlite*`, and no connection to `/tmp/codex-daemon-1000/<hash>` appeared in `ss -xp` sampled through a
run (the sandbox's `/tmp` is a private tmpfs). Attribution now also matches open descriptors under the client's own
directories, so this reports `host-busy` instead of `CHANGED`.

## 5. What R1–R2 do not prove yet

- **A signed-in inference exchange.** All four profiles are signed out; the 11 flows are control-plane, not LLM calls.
  Sign-in is the next operator step.
- **Codex over WebSocket for real.** The frame path is proven by the synthetic self-check; Codex opens
  `wss://api.openai.com/v1/responses` only after sign-in.
- **Server-sent trailers and HTTP/2 pseudo-headers.** Not emitted by the clients measured so far.
- **Per-frame SSE metadata beyond text and time** (e.g. `event:` name separately). The text is preserved verbatim, so
  the event name is recoverable; no separate field is added until a consumer needs it.

## 6. Files

| Path | Role |
|---|---|
| `scripts/recon/mitm/recon_addon.py` | capture addon (`recon-request/2`, `recon-response/3`, `recon-websocket/2`, `recon-error/2`, `recon-connections/1`, `recon-index/2`) |
| `scripts/recon/mitm/selfcheck.py` | synthetic contract check (73 checks) |
| `scripts/recon/mitm/python.ts` | resolves the interpreter from mitmdump's shebang |
| `scripts/recon/shared/redaction.json` | single redaction manifest |
| `scripts/recon/shared/manifest.ts` | validated typed access |
| `scripts/recon/run.ts` | passes client, version, cell, run label and manifest path to mitmdump; writes step markers |
| `scripts/recon/workflows/catalogue.ts` | 6 workflows × 4 clients, with the measured reason for an unsupported cell |
| `scripts/recon/workflows/types.ts` | workflow and step shapes (`exec`, `gui`) |
| `scripts/recon/timeline.ts` | steps → flows → connections, `summary`, `unmarked`; `recon-timeline/1` |
| `scripts/recon/sandbox/live.ts` | host-busy attribution from `/proc` command lines and open descriptors |
| `scripts/tests/unit/recon-capture.test.ts` | manifest, selfcheck and real-mitmdump tests |
| `scripts/tests/unit/recon-timeline.test.ts` | ordering, attribution, connection identity, `clientClosed`, round trip |
| `scripts/tests/unit/recon-workflows.test.ts` | catalogue shape, unsupported reasons, driver argv |

## 7. First signed-in capture: opencode (2026-10-20 18:20–18:29 UTC)

The opencode profile completed a device-flow login at 18:20 UTC (`credential created ... type=oauth active=true`,
credential row in `opencode.db`; `auth list` → `OpenCode Console  Default  stored`). Credentials are stored in the
profile only and never copied; see
[the login record](2026-10-20-12-13-recon-login-profiles.md).

### 7.1 The login itself, as recorded

Seven flows, all with bodies, zero refused bodies, zero surviving secret matches:

| Seq | Flow | Result |
|---|---|---|
| 1 | `GET https://models.opencode.ai/api.json` | 200 |
| 2 | `POST https://opencode.ai/console/auth/device/code` | 200 (device code issued) |
| 3 | `POST https://opencode.ai/console/auth/device/token` | 400 — authorization pending, the poll's normal first answer |
| 4 | `POST .../device/token` | 200 — `access_token`, `refresh_token`, `expires_in`, `token_type`, `org_id`, all redacted |
| 5 | `GET https://opencode.ai/console/api/user` | 200 |
| 6 | `GET https://opencode.ai/console/api/orgs` | 200 |
| 7 | `GET https://opencode.ai/console/api/v2/config` | response not completed before the client exited (client closed) |

The browser leg (the consent page the URL opened in the operator's browser) is on the host and outside the proxy by
design; the device flow does not need it captured, because the client's side is the whole protocol.

### 7.2 Six workflows, signed in

Each run is an isolated sandbox process with the per-run CA, probe `clean` and guard `unchanged`:

| Workflow | Flows | Steps | Exit | What the capture shows |
|---|---|---|---|---|
| `bootstrap` | 2 | 1 | 0 | model catalogue |
| `turn` | 4 | 1 | 0 | main turn **and** a second inference call |
| `turn-tools` | 5 | 1 | 0 | tool definitions, a tool round trip, then the answer |
| `multiturn` | 6 | 2 | 0 | two chat requests replaying history |
| `abort` | 4 | 1 | -1 (9 s cap) | stream cut by the client's timeout; `aborted: 1`, `errors: 0` |
| `error` | 2 | 1 | 1 | unknown model refused before an inference request |

### 7.3 Finding: a signed-in turn is two requests in two dialects

The `turn` run recorded:

| Seq | Dialect | Model | Stream |
|---|---|---|---|
| 3 | OpenAI Chat Completions (`/inference/go/openai/v1/chat/completions`) | `minimax-m3.1-flash-free` | yes |
| 4 | OpenAI Responses (`/inference/go/openai/v1/responses`) | `gpt-6-luna` | yes |

Both carry `Authorization` from the profile's credential. The second is the client's side call (title generation),
which is why the workflow catalogue treats side calls as part of a turn rather than noise. Before login, the keyless
free tier recorded only the Chat Completions shape; the signed-in path is the one that matters for reconstruction, and
it uses two dialects in one turn.

This is a capture finding, not a promoted golden: promotion stays an explicit reviewed step.

### 7.4 Counters: an abort is not an error

The first signed-in abort run showed `aborted: 1` and `errors: 1` for the same flow: the reason was written as an
error record (correct, it is evidence) and also counted in `counts.errors` (wrong, nothing failed). The addon now
counts an error only when no response was delivered; a client cancellation increments `aborted` alone, and its
`*-error.json` keeps `errorClass: "client-disconnect"` as the reason. Measured after the change: the abort workflow
produces `aborted: 1, errors: 0`, and the addon self-check asserts both halves (74 checks).

## 8. Identity redaction and evidence checks (2026-10-21)

### 8.1 Identity is redacted like a secret

Secrets were covered from R1; the operator's account was not. The manifest (`recon-redaction/2`) now also carries:

| Key | Entries | Evidence |
|---|---|---|
| `identityFields` | `email`, `given_name`, `family_name`, `verified_email`, `picture`, `account_uuid`, `device_id`, `preferred_username`, `organization_uuid`, `organizationUUID`, `accountUUID` | Google `userinfo`, Claude `metadata.user_id`, Claude telemetry bodies |
| `identityPatterns` | `email` anywhere; `organization`: the UUID after `/organizations/` | Claude Code calls `/api/organizations/<uuid>/…` and `/api/oauth/organizations/<uuid>/…` |
| `identityPatterns` (added 2026-10-22) | `workspace`: the OpenCode Console workspace id `wrk_` + 26 characters | OpenCode sends it as `x-opencode-org-id` on every inference request and the Console `api/v2/config` answer names it (run `opencode/2026-10-20-18-27-37/workflow`) |
| `identityScoped` | `id`, `name` only on `www.googleapis.com/oauth2/` and `opencode.ai/console/api/user` | elsewhere `id`/`name` are models and tools |

Fields are also redacted inside JSON carried as a string (Claude's `metadata.user_id`). Both redactors read the same
file: the addon self-check passes 83 checks (85 since the `workspace` pattern), `scripts/tests/unit/live-evidence.test.ts` asserts the same cases.

Measured on real traffic: Claude `turn` run `2026-10-22-02-04-42-workflow` → 216 `<REDACTED:organization…>` values,
0 raw organisation UUIDs in paths, 0 raw identity field values, 0 email-shaped strings. Runs recorded before this
change still contain identity values; they stay in the operator's local run directory and are not promotable.

### 8.2 A run must contain the request it was for

`expects` (per workflow) and `turnRequest` (per client) name the request a run exists to produce. A workflow or a
prompted login without it exits 1 and prints `evidence NONE`; `run.json` records `emptyWorkflow` / `missingTurn`.
