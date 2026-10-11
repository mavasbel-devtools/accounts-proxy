# P0-E6 — Browser (loopback) login mechanisms of both providers

Date: 2026-10-06 00:32 · Requirement: plan D10. Every supported provider that offers it must use browser login with
an automatic loopback redirect. Paste-code is allowed only as the headless fallback.

## 1. Claude (subscription OAuth): loopback IS supported. Evidence from the official binary

**Source:** the official Claude Code executable installed on this machine (the Windows machine used until 2026-10-07).

> Note 2026-10-10 (Linux migration): this binary is not on the Linux machine. The Linux `claude` is an older 2.1.29 (`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.29`), so the values below remain sourced from the hashed 2.1.280 Windows binary. P0-LIVE measures them again during the router's first real login.

| Item | Value |
|---|---|
| Path | `C:\Users\Marco\.local\bin\claude.exe` |
| `claude --version` | `2.1.280 (Claude Code)` |
| Size | 237,100,192 bytes |
| SHA-256 | `0e4195524b73eb77efbdf3e2b36de5322a29f0ca575dfd2d9b4f946b1d425469` |
| Byte offsets | reported by `scripts/evidence/scan-binary.ts` |

### 1.1 Production OAuth constants (offset 195,256,728; object `a`)

```
CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize"
CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize"
TOKEN_URL: "https://platform.claude.com/v1/oauth/token"
CONSOLE_SUCCESS_URL: "https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code"
CLAUDEAI_SUCCESS_URL: "https://platform.claude.com/oauth/code/success?app=claude-code"
MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback"
CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
```

The client ID is the same one `opencode-claude-auth` uses (`RequestTransformService.ts:52-58`).

### 1.2 Scopes requested at authorize (same offset; functions `kCr`, `gqe`)

- **Authorize** requests `kCr()`, the union of:
  - `[org:create_api_key, user:profile]`, and
  - `gqe()` = `[user:profile, user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload]`, plus `user:plugins`, because `PLUGINS_SCOPE_REGISTERED: !0`.
- **Refresh** sends `scope = gqe()`, with no `org:create_api_key`.

**Delta vs the plugin:** the plugin's `GRANTED_SCOPES` lacks `user:plugins`. The router follows the official 2.1.280 list.

### 1.3 Authorize URL builder `_Ln` (offset 197,855,226; verbatim excerpt)

```js
D.searchParams.append("code","true"),
D.searchParams.append("client_id",C?.clientId??nn().CLIENT_ID),
D.searchParams.append("response_type","code"),
D.searchParams.append("redirect_uri",s?nn().MANUAL_REDIRECT_URL:`http://localhost:${r}/callback`);
... ("scope",I.join(" ")), ("code_challenge",e), ("code_challenge_method","S256"), ("state",n)
```

- `s` is `isManual`. When it is false, the redirect is **`http://localhost:<port>/callback`**.
- The login base is `CLAUDE_AI_AUTHORIZE_URL` when `loginWithClaudeAi` is set, which is the subscription case.

### 1.4 Token exchange `M_r` (same region; verbatim excerpt)

```js
{grant_type:"authorization_code",code:e,
 redirect_uri:g?nn().MANUAL_REDIRECT_URL:`http://localhost:${s}/callback`,
 client_id:y??nn().CLIENT_ID,code_verifier:r,state:n}
POST nn().TOKEN_URL, headers {"Content-Type":"application/json"}, timeout 30000
```

- `redirect_uri` in the exchange must equal the one used at authorize, with the same port.
- A 401 means "Invalid authorization code".

### 1.5 Callback listener class (offset 213,894,990 and 213,895,411; verbatim behaviour)

- `createServer` from `http`; `callbackPath` defaults to `"/callback"`.
- `listen(e??0, "127.0.0.1")`: the port is **ephemeral (0)** unless one is given. It binds `127.0.0.1`, while the redirect host is `localhost`.
- `handleRedirect`:
  - path ≠ `callbackPath` → 404;
  - reads `code`, `state`, `error`;
  - `error` without `code` → error callback, which checks the state first;
  - no `code` → 400 `"Authorization code not found"`;
  - state mismatch → reject;
  - otherwise the response is **held** (`pendingResponse`) and the code is resolved.
- `handleSuccessRedirect`, after the token exchange: `302 Location: CLAUDEAI_SUCCESS_URL` when the granted scopes include `user:inference` (`SN` → `frn`); otherwise `CONSOLE_SUCCESS_URL`.
- `handleErrorRedirect`: `302 Location: CLAUDEAI_SUCCESS_URL`.

### 1.6 Router design consequence (D10)

`inference-router login claude` will:
1. start a loopback listener on `127.0.0.1:0` (`/callback`);
2. build the authorize URL exactly as §1.3, with `redirect_uri=http://localhost:<port>/callback`, `code=true`, PKCE S256, a random state, and the §1.2 scopes;
3. open the system browser;
4. validate the state, then exchange per §1.4;
5. reply `302` to the success URL per §1.5;
6. time out after 300 s.

**Fallback:** `--manual` uses `MANUAL_REDIRECT_URL` and paste-code, for headless use only.

**Live proof:** that Anthropic's authorization server accepts this redirect *for this client* is shown by the official binary doing it. It is measured again on the router's first real login, and the result is recorded in this file.

## 2. Google (Antigravity): loopback already implemented in the base plugin

| Item | Value | Evidence (`opencode-antigravity-auth` @ 5c6f7c2) |
|---|---|---|
| Authorize | `https://accounts.google.com/o/oauth2/v2/auth`, `access_type=offline`, `prompt=consent`, `redirect_uri=http://localhost:<port>/oauth-callback` | `GoogleOAuthClientAdapter.ts:17-28`, `PluginConfig.ts:5-15` |
| Listener | `node:http` `listen(0,'127.0.0.1')`; resolves on `/oauth-callback` with `code` + `state`; replies 302 → `https://antigravity.google/auth-success?app=antigravity-ide` | `LoopbackCallbackServerAdapter.ts:17-63` |
| PKCE | not used by the plugin | `GoogleOAuthClientAdapter.ts` (no `code_challenge`) |

**Router:** `inference-router login antigravity` reuses this flow unchanged, with browser open plus loopback. Adding PKCE would be a wire change that was not measured, so it is **not** added unless verified against the official Antigravity IDE.

## 3. Measurement-tool defect found (recorded so it is not repeated)

1. **String search on a decoded copy misses matches.** Searching a 237 MB `Buffer.toString("latin1")` copy with `String#indexOf` (Bun 1.4.2) returned **0** hits for `MANUAL_REDIRECT_URL`, while `Buffer#indexOf` on the raw bytes returns **6**. The scanner therefore searches raw bytes only.
2. **The shell tool passes quotes through literally.** It forwards `"..."` quotes as part of argv, so a quoted pattern searches for the quotes themselves. Patterns are passed unquoted.
