# R0 — recon capture capability matrix

Part of [recon plan](../plans/2026-10-19-20-04-recon-mitm-capture-plan.md) phase R0. Measured 2026-10-19 20:12–20:22
on this machine; every claim below is backed by a capture under
`tests/fixtures/captures/recon/<client>/<cell>/20261019-2022/` (schema `recon-run/0`, one JSON per request/response).

## 1. Result

| Client | Version | Transport | Interception | CA trust for the request path | Result | Evidence |
|---|---|---|---|---|---|---|
| opencode | 2.0.32 | HTTP/1.1 | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS` (Bun) | **capturable** | 2 exchanges, 0 TLS failures |
| Antigravity IDE | 1.107.0 | HTTP/1.1 | `--proxy-server` + `HTTPS_PROXY` | `--ignore-certificate-errors` + `NODE_EXTRA_CA_CERTS` for Node; `SSL_CERT_FILE` for the Go language server | **capturable, with a caveat** | run 1: 31 exchanges, 14 TLS alerts (Go LS); run 2: 31 exchanges, 0 alerts |
| Claude Code | 2.1.304 | HTTP/2 + 1.1 | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS` | **capturable** | 15 exchanges, 0 TLS failures |
| Codex CLI | 0.163.0 | HTTP/1.1 + WebSocket | `HTTPS_PROXY` | `SSL_CERT_FILE` (rustls) | **capturable (HTTP); WebSocket needs R1** | 18 exchanges, 0 TLS failures |

No client required a system CA install, sudo, or a change to the user's real config directory.

## 2. Per-client invocation

All runs bind the MITM to `127.0.0.1` on a dedicated port, use a per-run `confdir` (so the CA is never the user's
`~/.mitmproxy`), and pass `NO_PROXY=127.0.0.1,localhost`.

### opencode 2.0.32

```sh
env HOME=<tmp> XDG_CONFIG_HOME=<tmp>/config XDG_DATA_HOME=<tmp>/data XDG_CACHE_HOME=<tmp>/cache \
  HTTPS_PROXY=http://127.0.0.1:8899 NODE_EXTRA_CA_CERTS=<run>/mitmproxy-ca-cert.pem \
  opencode run --standalone -m recon/probe "…"
```

Config: a custom `@ai-sdk/openai-compatible` provider `recon` with `baseURL=https://api.anthropic.com/v1` and a dummy
key, so the probe needs no real credential. Capture shows `Authorization` (redacted), `User-Agent:
opencode/latest/2.0.32/cli`, `x-opencode-client`, `x-opencode-project`, `x-opencode-session`,
`x-opencode-session-id`, `x-session-affinity`, `x-session-id`, `b3`, `traceparent`.

### Antigravity IDE 1.107.0

```sh
env HOME=<tmp> SSL_CERT_FILE=<run>/mitmproxy-ca-cert.pem NODE_EXTRA_CA_CERTS=<run>/mitmproxy-ca-cert.pem \
  HTTPS_PROXY=http://127.0.0.1:8910 \
  xvfb-run -a -s "-screen 0 1280x800x24" \
  "<install>/bin/antigravity-ide" --user-data-dir=<tmp>/user-data --extensions-dir=<tmp>/extensions \
    --no-sandbox --disable-gpu --skip-welcome --skip-release-notes \
    --proxy-server=http://127.0.0.1:8910 --ignore-certificate-errors <workspace>
```

`<install>` is `/home/mavasbel/Downloads/Antigravity IDE` (the app runs in place; no installation elsewhere is needed).

### Claude Code 2.1.304

```sh
env HOME=<tmp> CLAUDE_CONFIG_DIR=<tmp>/config \
  HTTPS_PROXY=http://127.0.0.1:8911 NODE_EXTRA_CA_CERTS=<run>/mitmproxy-ca-cert.pem \
  ANTHROPIC_API_KEY=<dummy> claude -p "…" --model sonnet
```

A dummy key is enough to prove interception: `/v1/messages?beta=true` reaches the proxy and answers 401. No real
credential was copied or refreshed.

### Codex CLI 0.163.0

```sh
env HOME=<tmp> CODEX_HOME=<tmp>/codex \
  HTTPS_PROXY=http://127.0.0.1:8912 SSL_CERT_FILE=<run>/mitmproxy-ca-cert.pem \
  OPENAI_API_KEY=<dummy> codex exec --skip-git-repo-check "…"
```

## 3. Findings that change the plan

1. **Antigravity's Go language server does not use Node's CA settings.** Run 1 produced 14 `bad certificate` TLS
   alerts to `daily-cloudcode-pa.googleapis.com` while the same host answered 200 for the extension-host (Node)
   calls. Adding `SSL_CERT_FILE` removed every observed handshake failure in run 2, but run 2 was signed out, so the
   LS made no upstream call. **Proven:** the LS rejects the CA under `NODE_EXTRA_CA_CERTS` alone. **Not yet proven:**
   that `SSL_CERT_FILE` fixes the LS with a signed-in session (R0 follow-up).
2. **Antigravity isolation is incomplete with `--user-data-dir` alone.** Auth and the agent state live in
   `~/.gemini/antigravity-ide` (keyed to `HOME`), not in the user-data dir. Run 1 therefore used the real account and
   wrote `conversations/`, `brain/`, `implicit/` and `crashes/` there. Those artifacts were removed afterwards; no
   pre-existing file was overwritten. Capture runs must override `HOME`, and auth does not survive copying
   `user-data-dir` into a new `HOME` (run 2 was signed out), so each isolated home needs one interactive login.
3. **Codex uses WebSocket first.** It attempts `wss://api.openai.com/v1/responses` (visible as `GET` upgrades) and
   falls back to `POST https://api.openai.com/v1/responses`. The R0 addon records only the HTTP handshake, not
   frames. **R1 must add WebSocket flow capture** or the Codex cell will be partially blind.
4. **Antigravity's control plane is much wider than the plugin assumed.** Captured: `oauth2.googleapis.com/token`,
   `cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`, `daily-cloudcode-pa.googleapis.com/v1internal:{onboardUser,
   fetchUserInfo,fetchAvailableModels,setUserSettings,cascadeNuxes}`, `www.googleapis.com/oauth2/v2/userinfo`.
5. **Claude Code's control plane is also wider than the adapter**: `policy_limits`, `settings`,
   `claude_cli/bootstrap`, `claude_code_penguin_mode`, `organizations/metrics_enabled`, MCP registry pages,
   `event_logging/v2/batch`, and a Datadog intake at `http-intake.logs.us5.datadoghq.com`.

## 4. "Is it HSTS?"

No. HSTS only upgrades `http:` to `https:`; it cannot reject a certificate. The evidence is a plain TLS alert:

```
Client TLS handshake failed. The client does not trust the proxy's certificate for
daily-cloudcode-pa.googleapis.com (ssl/tls alert bad certificate)
```

The "Agent execution terminated due to error" string was inside the conversation database created by run 1, i.e. the
agent aborted because its upstream TLS handshake failed, not because of HSTS or pinning. `SSL_CERT_FILE` is the
untested-but-strong fix; R0 follow-up confirms it with a signed-in isolated run.

## 5. Cleanup performed

- Removed `~/.gemini/antigravity-ide/{conversations/a45ce2a8-*.db, brain/a45ce2a8-*, implicit/3b700c99-*.pb,
  crashes/crash_{938146,941212}_*.log}`, all created by run 1.
- Stopped every MITM and IDE process; no listener remains on 8899–8912.
- Temporary homes under `/tmp/opencode/r0/` hold copied user-data and per-run CAs; they are outside the repo and are
  deleted before R1 (nothing in them is needed once the captures above are committed).
