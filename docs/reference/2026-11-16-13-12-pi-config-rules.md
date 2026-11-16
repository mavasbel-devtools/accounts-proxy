# pi configuration rules P1–P7

Moved verbatim from `docs/design/2026-11-15-23-52-pi-compatibility-product.md` §4 in plan step 6.1, so this
document is the single copy. The product design links here instead.

## Provenance

| Fact | Value |
|---|---|
| pi version | 1.5.2, install path `/opt/homebrew/Cellar/pi-coding-agent/1.5.2` (npm `@earendil-works/pi-coding-agent`) |
| pi's published schema | `https://pi.dev/schemas/models.schema.json` |
| Schema SHA-256 | `3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc` (fetched 2026-11-15; equal to the installed copy) |
| Pinned schema file | `docs/reference/specs/pi-models-schema.json` |
| Model configuration reference | pi `docs/models-configuration.md:9-57` (one `api` and one `baseUrl` per model) |

## Configuration rules P1–P7

| Rule | Text | Evidence |
|---|---|---|
| P1 | One pi provider `ap-<provider>` per proxy provider whose catalog is not `unavailable`, named `AP · <name>` (the opencode names), `apiKey: "$ACCOUNTS_PROXY_TOKEN"`, no provider-level `api` or `baseUrl`. Every model carries its own `api` and `baseUrl`: pi checks both per model on the effective value and otherwise silently inherits them from another model of the provider (`findModelDefaults`). | O1 (`docs/reference/2026-10-16-01-38-model-catalog-rules.md:54`); pi `dist/core/provider-composer.js:83-90,117-123,177-180`; pi `docs/models.md:65` (`$NAME` interpolation) |
| P2 | Each model's format is the one rule O2 chooses (the reference AI SDK package's format when the model accepts it, else its first format); a model with no format is left out. Format → pi `api` and `baseUrl`: Messages → `anthropic-messages`, `<origin>/anthropic`; Chat → `openai-completions`, `<origin>/openai/v1`; Responses → `openai-responses`, `<origin>/openai/v1`; Gemini → `google-generative-ai`, `<origin>/gemini/v1beta`. | O2; pi `api/anthropic-messages.js:1026-1029` + SDK path `/v1/messages?beta=true`; `openai-completions.js:542-544`; `openai-responses.js:234-236`; `google-generative-ai.js:264-277` (`apiVersion: ""`); proxy probe 2026-11-15: `?beta=true` and a two-segment Gemini model route correctly |
| P3 | Model fields: `id` `<provider>/<model>`, `name`, `api`, `baseUrl`, `input` (the catalog's modalities restricted to `text` and `image`, the two pi accepts), `contextWindow`, `maxTokens` (`maxOutputTokens`), `reasoning`, `cost` when the catalog states one: the entry without `tier` is the base, each `{type: "context", size}` entry becomes `tiers[]` with `inputTokensAbove: size`; an unstated cache rate is `0`, pi's own value for an unstated rate. A field the catalog does not state is left out, so pi applies its documented default; subscription models state no price, so they carry no `cost`. | `AGENTS.md:126-128` (Model details); pi `providers/model-schema.js:28-46` (all four rates required when `cost` is given); `dist/core/provider-composer.js:107` (unstated cost = 0); live catalog 2026-11-15: 537 models with 1 cost entry, 99 with 2, 2 with 3 |
| P4 | Thinking: `reasoning` is `true` when the catalog says so or lists any reasoning option. A model with an `effort` option gets `thinkingLevelMap`: each pi level `minimal`, `low`, `medium`, `high`, `xhigh`, `max` maps to the same-named effort when the catalog lists it, else `null`; on `google-generative-ai` only `minimal`–`high` may be strings (pi throws on any other value), so `xhigh` and `max` are `null`; `off` is left unset (pi's default per api) except as P5 states. A model with an `effort` option on `anthropic-messages` gets `compat.forceAdaptiveThinking: true` (pi then sends `thinking: {type: "adaptive"}` plus `output_config.effort`, as pi's own catalog does for these models). A model with only `toggle` or `budget_tokens` options gets no map: pi uses its budgets. | pi-ai `providers/model-schema.js:12-23` (string or null only); `models.js:702-732`; `api/anthropic-messages.js:913-962`; `api/google-shared.js:19-31`; live catalog 2026-11-15: effort values `none minimal low medium high xhigh max`; all 12 claude effort models also list `budget_tokens` |
| P5 | Subscription cells (O6 analogue): `claude` models get `compat {supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, supportsMessageThreads: false}`, since the betas those features send (`mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01`) are outside the captured set; `openai` models get `reasoning: true` and `compat {supportsMaxOutputTokens: false, supportsMidConvoEffort: false}`, since plan usage refuses `max_output_tokens` and input items with role `system`, and pi sends the system prompt as role `developer` only when `reasoning` is `true` (pi-ai `api/openai-responses-shared.js:169`); the `off` level maps to `none` only when the catalog lists `none`, else `null`; `antigravity` models get `reasoning: false`, so pi sends no `thinkingConfig` and the proxy applies the catalog budget (wire law 13). | O6; `packages/provider-claude/src/domain/model-envelope.ts:39-51`; format fields §1 L35, §2 L86, §3 L109 |
| P6 | Gateways: each `ap-<gateway>` model gets the `compat` pi detects for that vendor's own host, so pi behaves as it does with the vendor directly. `openrouter`, Chat: `thinkingFormat: "openrouter"`, `sendSessionAffinityHeaders: true`, `sessionAffinityFormat: "openrouter"`, plus `cacheControlFormat: "anthropic"` for ids starting `anthropic/`, plus `supportsDeveloperRole: false` for ids starting neither `anthropic/` nor `openai/`. `openrouter`, Messages: `sendSessionAffinityHeaders: true`, `sessionAffinityFormat: "openrouter"`. `openrouter`, Responses: `sessionAffinityFormat: "openrouter"`. `opencode` and `opencode-go`, Chat: `supportsStore: false`, `supportsDeveloperRole: false`. `cheaper-inference`: none (pi detects nothing for its host). pi's per-model catalog `compat` is not copied: the proxy's own catalog is the only model source. | O6 ("gateways forward the request as sent"); pi-ai `api/openai-completions.js:1220-1348`, `api/anthropic-messages.js:146-164`, `api/openai-responses.js:49-51,65-80` (each run with `detectCompat`, 2026-11-15) |
| P7 | The document is `{"$schema": "https://pi.dev/schemas/models.schema.json", "providers": {...}}` and passes that schema (pi 1.5.2 copy, SHA-256 `3e4cb1963defc0ea67a25d81a652536ed0a0d480c536db04dabe9d02baad8bdc`, equal to the published one on 2026-11-15). `GET /.well-known/pi` answers `{auth: {command, env: "ACCOUNTS_PROXY_TOKEN"}, config: {url}}` with the opencode manifest's absolute token command. | O5; `/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent/schemas/models.schema.json` |

## Request shapes pi sends

The facts the rules rely on, each with its pi 1.5.2 path and line (`{pi}` =
`/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`,
`{pi-ai}` = `{pi}/node_modules/@earendil-works/pi-ai/dist`):

- **P2 URL joins.** pi passes the model's `baseUrl` as the SDK client's `baseURL`
  (`{pi-ai}/api/anthropic-messages.js:1029`; the openai and Gemini clients likewise take `model.baseUrl`:
  `{pi-ai}/api/openai-completions.js:187`, `{pi-ai}/api/google-generative-ai.js:264-275` with
  `httpOptions.apiVersion = ""` at line 268, so the version path comes from `baseUrl` itself). The request path is
  the SDK's own: the Anthropic SDK beta messages resource appends `?beta=true`
  (`{pi}/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs`, `messages?beta=true`). Hence
  `anthropic-messages` → `POST {baseUrl}/v1/messages?beta=true`, `openai-completions` → `POST {baseUrl}/chat/completions`,
  `openai-responses` → `POST {baseUrl}/responses`, `google-generative-ai` →
  `POST {baseUrl}/models/{id}:streamGenerateContent?alt=sse`.
- **Auth headers.** The Anthropic client sends `x-api-key`, falling back to `Authorization`
  (`{pi-ai}/api/anthropic-messages.js:352-353`). The OpenAI clients resolve the key with `getClientApiKey` and hand
  it to the OpenAI SDK client (`{pi-ai}/api/openai-completions.js:35-37,182-187`), which sends
  `Authorization: Bearer`. The Gemini client requires `options?.apiKey` and hands it to the GenAI SDK
  (`{pi-ai}/api/google-generative-ai.js:231-236,264-275`), which sends `x-goog-api-key`.
- **System prompt role.** On `openai-responses` pi sends the leading system prompt as role `developer` when the
  model has `reasoning` enabled, else as `system`
  (`{pi-ai}/api/openai-responses-shared.js:169`;
  `const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system"`).
  This is why P5 gives `openai` models `reasoning: true` and gateway Chat models `supportsDeveloperRole: false`.
- **Gemini tools as `parametersJsonSchema`.** pi's Gemini tool conversion uses `parametersJsonSchema`, which
  supports full JSON Schema including `const` rewritten as `enum`
  (`{pi-ai}/api/google-shared.js:384-403`; line 357 notes Gemini ignores `const` but honors `enum`). Hence the
  proxy's Gemini tool shape reaches pi unchanged (product design rule H).
- **No `toolConfig` for prefixed ids.** `functionCallingConfig` mode is set through `toolConfig` in the
  `generateContent` body builder (`{pi-ai}/api/google-generative-ai.js:302`); ids the proxy routes keep the
  body pi built, with no extra `toolConfig` injected.
- **`systemInstruction` role `user`.** The leading system message is flattened to text by `getSystemMessageText`
  (`{pi-ai}/api/../utils/text.js:11-18`) and sent as `systemInstruction`
  (`{pi-ai}/api/google-generative-ai.js:294-297`); later contents keep the `user` role
  (`{pi-ai}/api/google-shared.js:158-182`). Hence the proxy's Gemini `systemInstruction` handling matches what pi
  sends (product design rule G).
