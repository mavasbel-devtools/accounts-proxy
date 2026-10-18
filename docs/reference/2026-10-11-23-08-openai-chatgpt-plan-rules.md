# OpenAI provider rules (Sign in with ChatGPT, ChatGPT plan usage)

Completion plan v4 §3 step 1 ([plan](../plans/2026-10-11-22-11-completion-plan.md)). Every rule of the `openai`
provider is listed with its source. Specs are the official pages fetched into `docs/reference/specs/` on 2026-10-11
(`scripts/evidence/fetch-specs.ts`, hashes in `specs/manifest.json`); `chatgpt.ts` is opencode's built-in plugin
`packages/core/src/plugin/provider/chatgpt.ts` at commit `35ef229454`, vendored byte-identical under
`packages/provider-openai/tests/reference/plugin-35ef229454/`. Nothing here is guessed; where the sources leave a
choice open, the row says "design" and gives the reason.

## Sign-in

| # | Rule | Source |
|---|---|---|
| S1 | Authorize at `https://auth.openai.com/api/accounts/authorize` in the system browser | `openai-siwc-sign-in.md` §2; `chatgpt.ts:22,523` |
| S2 | First sign-in: `client_id=dynamic_agent_client` plus `agent_name_hint`; later sign-ins: the issued client id, without `agent_name_hint` | sign-in §2 table; accounts-and-sessions "Reauthorization"; `chatgpt.ts:20,524-525` |
| S3 | `agent_name_hint` = `inference-router` (the app's actual name, used consistently) | sign-in §2; decision O4 |
| S4 | `ext_agent_host_id`: a `urn:uuid:<UUIDv4>` created once per host and persisted before the first sign-in; never an email or user id | overview "A client vs. an agent host"; `chatgpt.ts:102-104` |
| S5 | `redirect_uri` = `http://127.0.0.1:<port>/auth/callback` (only the port varies; never `localhost`); the listener starts before the browser; the same URI is sent in the exchange | sign-in §2 table; `chatgpt.ts:148,199` |
| S6 | `scope` = `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource` = `https://api.openai.com/v1` | sign-in §2 table; `chatgpt.ts:24-25,532-533` |
| S7 | Fresh `state`, OIDC `nonce` and PKCE S256 verifier per attempt | sign-in §2; `chatgpt.ts:105-107,500-509` |
| S8 | Parameter order as `chatgpt.ts` sends it: `client_id`, `agent_name_hint` (first sign-in only), `ext_agent_host_id`, `response_type`, `redirect_uri`, `scope`, `resource`, `state`, `nonce`, `code_challenge_method`, `code_challenge`; `force_reconsent` is not sent | `chatgpt.ts:523-538`; errors-and-recovery "ChatGPT plan use isn't enabled" |
| S9 | Callback: `error` / `error_description` stops the attempt; a missing code or a wrong `state` is rejected; the new-registration callback carries the issued `client_id`; a different `client_id` than the saved one is rejected | sign-in §3; `chatgpt.ts:118-134,167-173` |
| S10 | Exchange: form POST to `https://auth.openai.com/api/accounts/oauth/token` with `grant_type=authorization_code`, the issued `client_id`, `code`, `code_verifier`, the same `redirect_uri`, `resource`; no client secret | sign-in §3; `chatgpt.ts:23,370-383` |
| S11 | The token response must grant `chatgpt.tokens.use.direct`, else the sign-in fails (plan usage not enabled) | sign-in §4; errors-and-recovery; `chatgpt.ts:175-180` |
| S12 | The ID token is verified: RS256 signature against `https://auth.openai.com/.well-known/jwks.json`, `iss` = `https://auth.openai.com`, `aud` = the issued client id, `exp` not passed, `nonce` = this attempt's, non-empty `sub` | sign-in §4; `chatgpt.ts:456-476` |
| S13 | The account identity is the verified `sub`, kept with the issued client id; the email is a label | sign-in §4–5; accounts-and-sessions "Managing ChatGPT accounts" |
| S14 | Stored: issued client id, host id, `sub`, email, id token (for `id_token_hint`), access and refresh tokens, expiry, granted scopes; file 0600, written atomically | sign-in §5 |
| S15 | Reauthorization of a saved account may send `id_token_hint` and `login_hint`; the router sends neither (as `chatgpt.ts`), because it prints the authorization URL to the terminal and the docs ask to keep a URL with `id_token_hint` out of logs (accounts-and-sessions "Credential security"). The account picker is `account use`; `login openai` re-authorizes the active registration, `login openai --new` registers another | sign-in §2 table; `chatgpt.ts:523-538` |
| S16 | No paste-code fallback: a headless host signs in elsewhere and receives the credential file (self-hosted VMs); `login openai` has no `--manual` | `openai-siwc-self-hosted-vms.md` |

## Tokens

| # | Rule | Source |
|---|---|---|
| T1 | Access tokens last 1 h (`expires_in: 3600`); refresh tokens 30 days, renewed on every refresh | `openai-siwc-token-reference.md` "Token lifetimes" |
| T2 | Refresh: form POST to the token endpoint with `grant_type=refresh_token`, the issued `client_id`, `refresh_token`, `resource`; `scope` omitted | accounts-and-sessions "Refreshing tokens"; `chatgpt.ts:390-399` |
| T3 | Every refresh returns a replacement refresh token; the access token, expiry, scopes and refresh token are replaced together; refreshes are serialized across processes | token-reference; accounts-and-sessions; sign-in §5 (Phase H session base) |
| T4 | Refresh errors `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused` mean a new login | errors-and-recovery "Refresh errors" (Phase H `needsLogin`) |
| T5 | Missing `expires_in` defaults to 3600 s | `chatgpt.ts:495` |

## Models and inference

| # | Rule | Source |
|---|---|---|
| M1 | Models: `GET https://api.openai.com/v1/models` with the bearer access token; the answer is `{models: [...]}`; models with `visibility: "list"` are shown, in server order, as `slug` (id) and `display_name` | `openai-siwc-models-and-inference.md` §1 |
| M2 | Built-in fallback list when the live list is unavailable: the 16 slugs of `chatgpt.ts:30-47` (opencode itself uses only this list since 2026-10-05, "due to openai bugs", commit `209346a0fe`) | `chatgpt.ts:30-47,301` |
| I1 | Inference: `POST https://api.openai.com/v1/responses` with `Authorization: Bearer <access token>`; never ChatGPT's `backend-api` | models-and-inference §2 |
| I2 | Every request sets `store: false` and `stream: true`; `input` is an array; success only after `response.completed`; `response.failed` / `response.incomplete` and interrupted streams are failures | models-and-inference §2–3; preview-limitations |
| I3 | Unsupported fields: `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`; and `previous_response_id` over HTTP; and `input` items `{type: "message", role: "system"}` | preview-limitations "Responses API requirements" |
| I4 | Unsupported tools: image generation, file search, Code Interpreter, computer use, hosted MCP/connectors, `tool_search`; `programmatic_tool_calling` not in top-level `tools` | preview-limitations |
| I5 | Request headers `session-id`, `thread-id`, `x-client-request-id` (opencode's, decision O9). Value: the client's own `session-id` header when it sends one, else the daemon's per-process session uuid (design: the router has no session of its own; the Claude identity uses the same per-process scheme) | `chatgpt.ts:276-279` |
| I6 | The stream ends with a terminal `response` whose `output` is empty; the items arrive only in `response.output_item.done`. The router fills the terminal response with those items (by `output_index`) for an aggregated answer and in the forwarded stream, every other frame unchanged. | live 2026-10-13: [findings F1](2026-10-13-02-52-live-validation-findings.md), `tests/fixtures/captures/p0-live/l1/openai-resp-*.json` |
| I7 | (added 2026-10-17) Every streamed 200 answer arrives with no `content-type` and with its request id in `x-oai-request-id` (no `x-request-id`); error answers carry `application/json`. A streaming client gets `content-type: text/event-stream` (the upstream's own value when it sends one) and `x-oai-request-id`; a non-streaming client gets `application/json` and `x-oai-request-id`. `x-request-id` (the public API's request-id header, `openai-openapi.yaml`) is still forwarded when present. | live 2026-10-13 and 2026-10-17: every `/v1/responses` exchange of `tests/fixtures/captures/p0-live/l1/openai-resp-*.json` (no `content-type` on the 200 streams, `application/json` on `s6-unknown-model`); user decision 2026-10-17 |

## Errors

| # | Rule | Source |
|---|---|---|
| E1 | Before a stream opens, admission may answer `{"detail": "..."}` with 401, 403 or 503; the status and body are passed on | errors-and-recovery "Before a stream opens" |
| E2 | Structured codes: `subscription_sharing_user_not_eligible` 403, `subscription_sharing_usage_limit_exceeded` 429, `subscription_sharing_usage_unavailable` 503, `subscription_sharing_unsupported_capability` 400, `subscription_sharing_route_not_supported` 403, `subscription_sharing_invalid_user` 401, `chatpass_v2_scope_not_authorized` / `chatpass_v2_invalid_authorization_context` 403, `subscription_sharing_user_unavailable` 503 | errors-and-recovery "Structured Responses errors"; opencode `session/to-session-error.ts:10-25` |
| E3 | A usage limit can also arrive as `response.failed` after streaming began | models-and-inference §3 |
| E4 | No automatic retry for the non-retryable sharing codes | `chatgpt.ts:48-56,259-266`; AGENTS.md quota law |

## Open points for the live probe (P4.5 step 2)

- Whether plain top-level `function` tools are accepted ("group function/custom tools in namespaces or supply them
  through `additional_tools`", preview-limitations).
- The live model list (opencode stopped using it on 2026-10-05).
- The error body of an unsupported field (`subscription_sharing_unsupported_capability` with `error.param`).
- Refresh rotation and reuse of the previous refresh token.

## Amendment 2026-10-16: project rename

The project is now `accounts-proxy` ([project rename](2026-10-16-14-40-project-rename.md)): `agent_name_hint` = `accounts-proxy` (S3, still the app's actual
name) and `User-Agent: accounts-proxy/0.1.0`. An account registered before the rename keeps its issued client id
(S2), so the new hint is sent only by a first sign-in (`login openai --new`).
