# Gateway provider rules (P4.6): `openrouter`, `opencode`, `opencode-go`, `cheaper-inference`

[Plan P4.6](../plans/2026-10-12-15-35-p46-gateway-providers-plan.md). Every rule cites its source. Specs are in
`docs/reference/specs/` (fetched 2026-10-12, SHA-256 in `manifest.json`). Pinned sources:

| Source | Commit | Git blob |
|---|---|---|
| opencode `packages/web/src/content/docs/zen.mdx` | `35ef229454` | `125ddd2fdbb25df7b8fb7974709fff685cc44ff2` |
| opencode `packages/web/src/content/docs/go.mdx` | `35ef229454` | `f2b2b0f0339043dab63fbc496b164b9f93328f58` |
| opencode `packages/console/app/src/routes/zen/util/handler.ts` | `35ef229454` | `ed4aaeb36d62ae3c9d6f3b50dba282ec881af509` |
| opencode `packages/console/app/src/lib/inference-proxy.ts` | `35ef229454` | `f11b9a911f2e7195cda251678b3331d95b3677e8` |
| opencode `packages/console/core/src/model.ts` | `35ef229454` | `b2ba61c1e72faf8897d399302bb88eac072c4252` |
| opencode `packages/core/src/plugin/provider/opencode.ts` | `35ef229454` | `75de26333acf0889c484f5b2a138d858c6b8b22b` |
| opencode-cheaper-inference-auth `src/infrastructure/config/PluginConfig.ts` | `f2c5e23` | `32cb908c5d0477db1476b281ccfb5cdfc450dce1` |
| opencode-cheaper-inference-auth `…/sources/CheaperInferenceHttpAdapter.ts` | `f2c5e23` | `ce1b90b51e25acd5f60c2f1e0a647592d86ec9da` |

## 1. Wire formats

| Router route | Format |
|---|---|
| `POST /anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens` | `anthropic-messages` |
| `POST /openai/v1/chat/completions` | `openai-chat` |
| `POST /openai/v1/responses` | `openai-responses` |
| `POST /gemini/v1beta/models/{model}:{method}` | `gemini` |

## 2. `openrouter`

| # | Rule | Source |
|---|---|---|
| R1 | API base `https://openrouter.ai/api/v1`; every operation authenticates with `Authorization: Bearer <key>` | `openrouter-openapi.yaml` `servers`, `securitySchemes.apiKey` (bearer), global `security` |
| R2 | Native formats for every model: `POST /chat/completions`, `POST /responses`, `POST /messages` (Anthropic Messages, "Anthropic Skin") | openapi paths `sendChatCompletionRequest`, `createResponses`, `createMessages`; `openrouter-claude-code.md` |
| R3 | No `count_tokens` endpoint | openapi: `/messages/count_tokens` absent |
| R4 | Model list `GET /models`, public; per model `id`, `name`, `created` (Unix s), `context_length`, `top_provider.max_completion_tokens` | openapi `getModels`; `openrouter-models.json` (459 models) |
| R5 | Browser login (PKCE): `https://openrouter.ai/auth?callback_url=<url>&code_challenge=<S256>&code_challenge_method=S256&state=<s>`; localhost callbacks on any port; the redirect carries `code` (and `state`, returned unchanged) | `openrouter-oauth-pkce.md` "Step 1", "Localhost Apps", "Optional Parameters" |
| R6 | Headless login: the same URL without `callback_url`, with `code_challenge` (required) and `key_label`; the page shows the code to paste; no `state` is returned | `openrouter-oauth-pkce.md` "Headless Apps" |
| R7 | Code exchange `POST https://openrouter.ai/api/v1/auth/keys` JSON `{code, code_verifier, code_challenge_method}` → `{key, user_id}`; codes are single-use and expire after 10 min | `openrouter-oauth-pkce.md` "Step 2"; openapi `exchangeAuthCodeForAPIKey` |
| R8 | Key information `GET /key` → `data.{label, usage, limit, limit_remaining, limit_reset, is_free_tier}` (used for `quota openrouter`) | openapi `getCurrentKey` |
| R9 | Errors `{"error": {"code", "message", "metadata"?}}` with 400/401/402/403/408/429/502/503; a 429 may carry `Retry-After` | `openrouter-errors.md` "Error codes", "Retry-After header" |
| R10 | SSE streams may contain comment lines (`: OPENROUTER PROCESSING`); they are passed through unchanged | `openrouter-streaming.md` |
| R11 | The generation id is returned in the `X-Generation-Id` response header on every endpoint | `openrouter-streaming.md` |

## 3. `opencode` (Zen) and `opencode-go`

| # | Rule | Source |
|---|---|---|
| Z1 | Bases `https://opencode.ai/zen/v1` (Zen) and `https://opencode.ai/zen/go/v1` (Go) | `zen.mdx` "Endpoints"; `go.mdx` endpoint table; `inference-proxy.ts` `paths` |
| Z2 | Endpoints: `POST {base}/chat/completions`, `/responses`, `/messages`; Zen only: `POST /zen/v1/models/{model}:generateContent` and `:streamGenerateContent` | `inference-proxy.ts` `paths` and the `/zen/v1/models/…` rule; Go has no Gemini route there |
| Z3 | The key is read from `x-api-key` on `/messages`, from `x-goog-api-key` on the Gemini routes, and from `Authorization: Bearer` elsewhere | `inference-proxy.ts` (`key` selection); `routes/zen/v1/*.ts` `parseApiKey` |
| Z4 | Model lists `GET {base}/models` (public, OpenAI list shape, ids only) | `inference-proxy.ts` (`GET /zen/v1/models`, `GET /zen/go/v1/models`); `opencode-{zen,go}-models.json` |
| Z5 | A model's format is the per-model `provider.npm` of models.dev, defaulting to the provider's `npm`: `@ai-sdk/openai` → `openai-responses`, `@ai-sdk/anthropic` → `anthropic-messages`, `@ai-sdk/google` → `gemini`, `@ai-sdk/openai-compatible` and `@ai-sdk/mistral` → `openai-chat` | `models-dev-gateways.json`; `zen.mdx`/`go.mdx` tables (e.g. Mistral Large 4 → `/zen/v1/chat/completions`) |
| Z6 | A model whose format is not known (absent from models.dev) is forwarded in the client's format; the gateway answers an unknown model or format itself (`ModelError`) | `handler.ts` (`modelNotSupported`, `modelFormatNotSupported`) |
| Z7 | Keys: new Console keys start `oc_sk_`; legacy keys start `sk-` | `inference-proxy.ts` (`legacy = !key.startsWith("oc_sk_")`, "every legacy key is `sk-`") |
| Z8 | Keyless use is not available to the router: `Bearer public` and no key both answered **403** `FreeTierError` "OpenCode's free tier can only be used from within OpenCode" (live, 2026-10-12) | live check, plan §2 item 5 |
| Z9 | Errors `{"type":"error","error":{"type","message"}}`; responses carry `x-opencode-log-id` | `handler.ts` `error()`; live check headers |
| Z10 | Console device login (`opencode.ts`) issues tokens for the Console API; nothing shows Zen/Go accepting them (a non-`oc_sk_` key is looked up as a legacy key) → not offered (N5) | `opencode.ts`; `inference-proxy.ts` |
| Z11 | Go: `GET /zen/go/v1/usage` exists; its response is undocumented (used only as the key check at login, status 200) | `inference-proxy.ts` `paths` |

## 4. `cheaper-inference`

| # | Rule | Source |
|---|---|---|
| C1 | Base `https://api.cheaperinference.com/v1`; `Authorization: Bearer` or `x-api-key` on every endpoint; keys start `ci_live_` (legacy `ir_live_`) | `cheaper-inference-llms-full.txt` [quickstart], [api-keys]; openapi `securitySchemes` |
| C2 | Endpoints `POST /chat/completions`, `/responses`, `/messages`, `/messages/count_tokens` | [chat-completions], [responses], [messages]; openapi paths |
| C3 | `GET /v1/models` (authenticated): `data[].{id, context_length, max_output_tokens, endpoint, supported_endpoints}`; send each model only to an endpoint it lists | [models], [endpoint-formats]; openapi `/v1/models` schema |
| C4 | `GET /public/models` (no key): `models[].{id, context_length, max_output_tokens, endpoint, supported_endpoints}` | openapi `/public/models`; `cheaper-inference-public-models.json` (97 models) |
| C5 | Dedicated Pro models require `/v1/responses` with `stream: false` (refused up front otherwise) | [endpoint-formats], [pro-reasoning] |
| C6 | `GET /v1/account` → `email`, `workspace_name` (login check and account identity) | openapi `/v1/account` |
| C7 | `GET /v1/account/balance` → `balance_usd`, `available_usd`, `reserved_usd`, `currency` (used for `quota cheaper-inference`) | openapi `/v1/account/balance` |
| C8 | Errors: OpenAI shape on OpenAI endpoints, Anthropic shape on `/messages`; 402 `insufficient_balance`, 429 retry with backoff; request id `x-ci-request-id` | [errors], [rate-limits], [headers] |
| C9 | Requests may run up to 795 s | [timeouts] |

## 5. Router rules derived from the above

| # | Rule |
|---|---|
| G1 | The client's body `model` (`<provider>/<model>` or an alias) is replaced by the bare model id; the Gemini path model likewise. |
| G2 | Request headers sent upstream: the key header (Z3 / bearer), `content-type: application/json`, `accept` from the client, and on `anthropic-messages` the client's `anthropic-version` and `anthropic-beta`. Nothing else from the client is forwarded. |
| G3 | The response is streamed back unchanged; forwarded headers: `content-type`, `retry-after`, and the vendor's request id (`x-generation-id` R11, `x-opencode-log-id` Z9, `x-ci-request-id` C8). |
| G4 | A format the model does not accept natively is a translated cell: 400 `unsupported_feature` until P5. `count_tokens` goes only to a provider that has it (Cheaper, C2); elsewhere it is 400 `unsupported_feature`. |
| G5 | Catalogs: live → cached copy (24 h) → built-in list generated from the committed lists above (never empty while a list is committed). |
| G6 | A fixed key is never renewed; an upstream 401 reaches the client unchanged, and the account keeps working for other requests. |

## 3a. `opencode` and `opencode-go` after the 2026-10-12 Console migration (plan P4.6 amendment A)

Supersedes Z1–Z3, Z7, Z10, Z11 (kept above for the record). Sources: `opencode-console-*.html` (fetched 2026-10-12,
manifest.json); opencode `packages/console/app/src/lib/inference-proxy.ts` @ `b9ca4d21b4` (blob
`228d046e0280a24e10f381a04b3071c52942a9ef`); `packages/core/src/plugin/provider/opencode.ts` (blob
`75de26333acf0889c484f5b2a138d858c6b8b22b`, unchanged); `packages/util/src/global-roots.ts` (blob
`a9324e4987d1b5c118d1cb4a082b8ab0bb721c6f`) and `…/migration/20260805200742_import_legacy_credentials.ts` (blob
`0da25f13041716336b07dbe44c8362dee40eb39d`) @ `35ef229454`; live probe
[2026-10-12-23-40](2026-10-12-23-40-p46a-console-live-probe.md).

| # | Rule | Source |
|---|---|---|
| Z12 | Console inference base `https://opencode.ai/inference`: `POST /openai/v1/chat/completions`, `/openai/v1/responses`, `/anthropic/v1/messages`, `/google/v1beta/models/{model}:generateContent` (`:streamGenerateContent` streams); models `GET /v1/models` | `opencode-console-inference-api.html` "Endpoints"; `opencode-console-models.html` "Model list"; live c0 (each route 401 without a key) |
| Z13 | Go base `https://opencode.ai/inference/go`: `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages`; models `GET /v1/models` | `opencode-console-go.html` "Endpoints", "Models"; live c0-go-models |
| Z14 | Every endpoint takes the credential as `Authorization: Bearer <token>` (service-account key or device access token) | `opencode-console-inference-api.html` "Authentication"; `opencode-console-api.html` "Service accounts" |
| Z15 | Go wants the client's own `User-Agent` and a stable `x-opencode-session` per conversation; without the header Go answers **400** `MissingSessionID` | `opencode-console-go.html` "Where can I use it?"; live c0-go-chat |
| Z16 | Keys: a service account's API key (`oc_sk_…`, *Keys › Add Service Account › Add API Key*, shown once), bound to one workspace | `opencode-console-api.html` "Service accounts" |
| Z17 | Device login (RFC 8628, "other CLIs can use the same flow"): `POST /console/auth/device/code` (`client_id`, `supports_org_scope=true`) → `device_code`, `user_code`, `verification_uri_complete` (relative to `https://opencode.ai`), `expires_in` 600, `interval` 5; poll `POST /console/auth/device/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`) every `interval` s: 400 `authorization_pending` until approval (`slow_down` adds 5 s), then `access_token`, `refresh_token`, `expires_in`, `org_id`; the token is bound to the chosen workspace | `opencode-console-api.html` "Device flow"; `opencode.ts` `poll` (slow_down +5 s); live c2 (client id `inference-router` accepted) |
| Z18 | Renewal `POST /console/auth/device/token` (`grant_type=refresh_token`, `refresh_token`, `client_id`); each refresh token is single-use and reusing an old one revokes the whole session; a rejected grant is 400 `invalid_grant` | `opencode-console-api.html` "Device flow"; `opencode.ts` `refresh` |
| Z19 | Identity after the device login: `GET /console/api/user` (`id`, `email`) and `GET /console/api/orgs` (`[{id, name}]`), bearer access token | `opencode.ts` `credential` |
| Z20 | `GET /console/api/v2/config` (bearer; every key permission and member role may read it) → `providers.<id>.{settings, headers, models}`, e.g. `headers: {"x-opencode-org-id": "org_…"}`; errors `{"_tag": …}`, 401 = missing/invalid/expired/revoked credential | `opencode-console-api.html` "Workspace config", "Errors"; live c3 (`{"_tag":"Unauthorized"}`) |
| Z21 | Z8 still holds at the new address: a free model without a key answered **403** `FreeTierError` (the docs' "free chat models can be called without it" does not hold for the router) | live c1 |
| Z22 | OpenCode's legacy credential file `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`: an object keyed by provider id; an API key is `{"type": "api", "key", "metadata"?}`, a sign-in `{"type": "oauth", …}` | `global-roots.ts`; `import_legacy_credentials.ts` (`LegacyKey`, `LegacyOAuth`) |
| Z23 | Upstream error bodies of the inference routes keep each format's own shape (OpenAI `{"error":{…}}`, Anthropic `{"type":"error",…}`, Gemini `{"error":{"code","status","message"}}`) | live c0 |
| Z24 | Go refuses a request without `x-opencode-session` (400 `MissingSessionID`); Claude Code sends none, only `metadata.user_id` ending in `_session_<uuid>`. Router rule: without a client header the router sends the conversation's own id (that session, or the Responses `prompt_cache_key`), else `rtr_` + a 64-bit FNV-1a hash of the first user turn. | live 2026-10-13 L3: [findings F3](2026-10-13-02-52-live-validation-findings.md); `opencode-console-go.html` "Where can I use it?" |
| Z25 | Zen `deepseek-v4-flash` and `kimi-k2.6` answer 404/410 "Upstream request failed: Endpoint is unavailable." on the documented Chat path and on models.dev's base while `glm-5.1` answers 200: a model's availability is the vendor's, passed through unchanged. | live 2026-10-13: `tests/fixtures/captures/p0-live/l1/opencode-z*.json` |

Router rules added by amendment A:

| # | Rule |
|---|---|
| G7 | Every gateway's key travels as `Authorization: Bearer` (R1, C1, Z14); the per-endpoint headers of Z3 are gone. |
| G8 | OpenCode requests carry, besides G2, the router's `User-Agent` (Z15), the workspace's config headers for that provider (Z20) and the client's `x-opencode-session` when it sent one (Z15). |
| G9 | `opencode` and `opencode-go` use one account pool (`accounts-opencode.json`, decision K2): a device sign-in (renewed under the Phase H rules, Z18) or a service-account key (never renewed). |
| G10 | `login <gateway> --from-opencode` imports the provider's entry of OpenCode's `auth.json` only when it is an API key (Z22); a sign-in entry is refused. |
