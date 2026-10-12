# Plan: P4 — daemon and the two native cells

Status: **approved, in execution**. Q1–Q5 approved 2026-10-11 ("proceed as per your recommendations"); amendment B
(below, from the P0-LIVE evidence) Q6–Q7 approved 2026-10-11 ("proceed as per your recommendation with both"). Parent plan: [2026-10-06-00-23-inference-router-plan.md](2026-10-06-00-23-inference-router-plan.md) (v3.1) · Continuation: [2026-10-10-18-45-continuation-plan.md](2026-10-10-18-45-continuation-plan.md) (amendment A2: P4 before P0-LIVE, approved 2026-10-10).

Everything below was read from the code at `2ef50ec`, from the specs in `docs/reference/specs/`, from the Antigravity plugin's `docs/research/antigravity-protocol/SPEC.md` (@ `5c6f7c2`), and from the SDK documentation pulled on 2026-10-10 (Context7 and the npm registry). Each section names its source.

## 1. Starting point (measured)

| Piece | State at `2ef50ec` |
|---|---|
| `ClaudeSubscriptionProvider.passthrough` | Done. Native routes `/v1/messages` and `/v1/messages/count_tokens`. Envelope and prefill guard applied. The upstream body is **streamed** chunk by chunk. Forwarded headers: `content-type`, `retry-after`, `request-id`, `anthropic-ratelimit-*`. |
| Claude fix F4 (honour the client's `anthropic-beta`) | **Not implemented.** `passthrough` ignores `request.headers`; `anthropic-beta` comes only from the per-model envelope (`request-transform.ts:176`). The parent plan says the merge rule comes from captures. |
| `AntigravityProvider.passthrough` | **Stub**: throws `unsupported_feature` ("arrives in P4/P5"). |
| `AntigravityChat` | Done, but only for the OpenAI-shaped `ChatRequest` (the plugin relay's model). It handles the trajectory, the 401 rotation, the geo-gate retry, and signature capture. |
| Antigravity `countTokens` upstream | **None exists.** SPEC.md §2 lists every `/v1internal:*` endpoint, and none counts tokens. |
| `PassthroughPort` / `ListModelsPort` (core inbound) | Declared. `ListModelsService` exists; the HTTP adapter, the routes, the token and `serve` do not. |
| Test seams for upstream hosts | `ClaudeSubscriptionProvider(apiBase)` and the Antigravity API client `host` are constructor parameters, but the composition root never overrides them. |
| e2e tier | Empty, so `verify` reports INCOMPLETE. |

## 2. Scope

### 2.1 Daemon (`apps/router`)
- **`HttpServerAdapter`** (inbound adapter, `node:http`, D7). It binds `127.0.0.1:<port>`; `EADDRINUSE` is fatal, with a named error. Bodies are capped at 32 MiB, and a larger body is rejected with 413 (Anthropic's own documented request-size limit is the reference, `anthropic-errors.md` §Request size limits; the exact figure is checked there at implementation time).
- **Streaming:** upstream chunks are written to the client as they arrive. If the client disconnects, the upstream request is aborted (`AbortSignal` on `HttpTransportPort`; this needs a small addition to core `HttpRequest`).
- **Shutdown:** on SIGINT/SIGTERM, stop accepting connections, let in-flight responses finish for up to 10 s, then close and exit through `main`. This keeps e2e coverage working (AGENTS §5).
- **`AuthGuard`** (D6): a router token of 32 random bytes, base64url, stored in `<data>/token` (mode 0600) and created on first `serve` or `token`. Accepted carriers: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`. Comparison uses `crypto.timingSafeEqual` over equal-length digests. Every route except `GET /health` requires the token. The 401 body is in the shape of the route's dialect.
- **Route table** (D2, P4 subset):

| Route | P4 behaviour |
|---|---|
| `GET /health` | `{status:"ok", providers:[…enabled]}`, no token needed |
| `POST /anthropic/v1/messages` | `claude/<model>` → native passthrough. `antigravity/<model>` → 400 `unsupported_feature` (translated cell, P5). |
| `POST /anthropic/v1/messages/count_tokens` | same split |
| `GET /anthropic/v1/models` | all enabled providers' models, Anthropic list shape |
| `GET /openai/v1/models` | OpenAI list shape |
| `POST /openai/v1/chat/completions` | 400 `unsupported_feature` (both OpenAI cells are translated: P5) |
| `POST /gemini/v1beta/models/{model}:streamGenerateContent` | `antigravity/<model>` → near-native cell. `claude/<model>` → 400 (P5). |
| `POST /gemini/v1beta/models/{model}:generateContent` | near-native cell, non-streamed (see §2.3) |
| `POST /gemini/v1beta/models/{model}:countTokens` | 400 `unsupported_feature`: Antigravity has no upstream count (§1) |
| `GET /gemini/v1beta/models` | Gemini list shape |
| anything else | 404 in the shape of the path's dialect |

- **Model addressing** (D8): `<provider>/<model>` or an alias. On Gemini routes the `{model}` segment is accepted both URL-encoded (`antigravity%2Fgemini-…`) and raw (`antigravity/gemini-…`, everything between `models/` and the last `:`). Which form `@google/genai` 2.28.0 sends is measured in e2e, not assumed.
- **Dialect error shapes**:
  - Anthropic: `{type:"error", error:{type, message}}` (`anthropic-errors.md` §Error shapes).
  - OpenAI: `{error:{message, type, param, code}}` (`openai-openapi.yaml`, `ErrorResponse`).
  - Gemini: Google `{error:{code, message, status}}`, taken from the plugin's captured cloudcode error bodies; the fixture path is cited in the code.

  Upstream errors on native cells pass through unchanged (status, body, and the forwarded headers including `retry-after`). Router-generated errors map from the core error tree.
- **CLI:**
  - `serve` runs the daemon in the foreground.
  - `token` prints the router token, creating it if absent.
  - `status` calls `GET /health` on the configured port.

### 2.2 Anthropic → `claude` (native)
- Uses the existing passthrough unchanged, except for **F4**. That rule needs evidence, so it is built in two parts:
  1. **Now:** the client's `anthropic-beta` values are merged (set union, client order first, then the per-model envelope values not already present) **only for the beta names already in the captured envelope list for that model**.
  2. **Unknown beta names:** a name outside that list returns 400 `unsupported_feature: anthropic-beta:<name>`; `x-router-lossy: 1` drops it and reports it.

  Source of the comma-list format: `anthropic-messages.md` (the `anthropic-beta` header parameter). Whether Claude-subscription traffic accepts betas the envelope doesn't list is a P0-LIVE question (E3), so nothing unproven is forwarded.
- **Request headers:** apart from `anthropic-beta`, client request headers are not forwarded (auth and identity are the router's own; parent plan D5/D6). `anthropic-version` from the client must equal the envelope's value; a different value gets 400.

### 2.3 Gemini → `antigravity` (near-native)
A new provider-internal port `AntigravityNativePort.generate(modelWireId, geminiBody)` yields raw upstream envelopes. It reuses `AntigravityChat`'s loop, which is first factored into a shared runner: trajectory snapshot, proactive refresh, one 401 rotation, the geo-gate retry, and the step counter.

**Request mapping.** Sources: the SPEC.md §3 request capture and the router's wire laws.

| Client field (public Gemini) | Rule |
|---|---|
| `contents`, `systemInstruction`, `tools[].functionDeclarations`, `toolConfig`, `generationConfig` | Carried into `request`. These are the only fields seen in the captured IDE envelope. |
| `generationConfig.thinkingConfig.thinkingBudget` | Must equal the catalog value (law §0.1 catalog-exact). If absent, it is injected (law 13). A different value gets 400 unless lossy, in which case it is replaced and reported. |
| `generationConfig.maxOutputTokens` | Client value if present and ≤ the catalog maximum; otherwise the catalog value (SPEC §3). A value above the catalog maximum gets 400. |
| tool `parameters` schema keywords outside the law-5 whitelist | 400 naming the keywords; lossy sanitizes them (law 5) and reports them. **Decision Q2.** |
| `safetySettings`, `cachedContent`, `tools[].googleSearch` / `codeExecution` / other tool kinds, `parametersJsonSchema`, `responseSchema`, `responseMimeType`, anything else | 400 `unsupported_feature` naming the field: never captured, so never guessed. P0-LIVE E3 can widen this list. |
| `labels`, `sessionId` | Always set by the router (trajectory law, int64 string law). Client values get 400. |
| client `thoughtSignature` on parts | Passed through unchanged. |
| Gemini `functionCall` without a signature | First filled from the router's signature cache; still missing → the call and its `functionResponse` are dropped (law 6). **Decision Q3.** |
| content-free contents; trailing model turns | Law 8 drop; law 12 strip, after the law-6 drop. **Decision Q3.** |

**Trajectory input.** `TrajectoryState.begin` takes the plugin's `ChatMessage[]`. Gemini `contents` are converted to that turn view (user text → `user`, `functionResponse` → `tool`, model → `assistant`). This is a pure function, unit-tested against the plugin's trajectory captures.

**Response mapping.** Each envelope is unwrapped to `envelope.response`, which has the public `GenerateContentResponse` shape (SPEC §3 inner shape). Thought signatures seen in the stream are cached (law 6).

| Client call | Output |
|---|---|
| `:streamGenerateContent?alt=sse` | `data: <response json>\r\n\r\n` per envelope, streamed |
| `:streamGenerateContent` without `alt=sse` | one JSON array of responses, still written incrementally (`[`, then elements, then `]`) |
| `:generateContent` | the chunks merged into one response. **Decision Q4.** |

Errors before the first byte use the dialect shape and status. After the first byte: for SSE, a final `data: {"error":{…}}` frame, then the stream is closed; for a JSON array, the array is closed with an error element.

### 2.4 Models endpoints
`ListModelsService` gains a `source` per provider (`live`, `cache` or `static`): the P0-LIVE plan §7 finding. The CLI prints it and HTTP returns it in the header `x-router-models-source: claude=live,antigravity=live`.

| Dialect | Fields (spec) | Router values |
|---|---|---|
| Anthropic (`anthropic-models-list.md`) | `{data:[{type:"model", id, display_name, created_at}], has_more, first_id, last_id}` | `created_at` from the Claude catalog. Antigravity's catalog has no date. **Decision Q5.** |
| OpenAI (`openai-openapi.yaml` `ListModelsResponse`) | `{object:"list", data:[{id, object:"model", created, owned_by}]}` | `owned_by` = provider id. `created` from Claude's `created_at`; Antigravity: Q5. |
| Gemini (`gemini-models.md` §Model) | `{models:[{name:"models/<id>", baseModelId, version, displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods}]}` | `inputTokenLimit`/`outputTokenLimit` from the advertised limits (Antigravity limit law 4). `supportedGenerationMethods`: `["generateContent","streamGenerateContent"]` for antigravity; `[]` for claude until P5. `version`/`baseModelId`: Q5. |

### 2.5 Upstream test seams
- Hermetic e2e needs the daemon to talk to loopback replay upstreams.
- **Seam variables** (`INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API`, `…_CLAUDE_OAUTH`, `…_ANTIGRAVITY_API`, `…_GOOGLE_OAUTH`): the composition root reads them **only when the value's host is `127.0.0.1`**. Any other value is a fatal config error, so production can't be repointed. This mirrors the plugin's hermetic-only `ANTIGRAVITY_STABLE_HOST` rule.
- **Browser in e2e:** a fake `xdg-open` placed first on the child's `PATH` follows the authorize URL to the replay OAuth server, which redirects back to the loopback listener. The CLI login is then e2e-tested black-box, with no code seam.

## 3. Tests

| Tier | Content |
|---|---|
| unit | route parsing, model-segment decoding, auth carriers and the constant-time compare, dialect error encoders, beta merge, the Gemini request validator/mapper, contents → turn view, response aggregation, models encoders |
| component | the HTTP adapter on a real loopback socket with fake ports: streaming order, client abort → upstream abort, 413, shutdown drain, 401/404 shapes |
| e2e | the **built** `dist/inference-router.js`, spawned with `--preload scripts/gate/e2e-coverage-preload.ts` against replay upstreams that serve the plugins' committed captures (Claude text, tool use, thinking, 400s, catalog; Antigravity stream, models, quota). Covered: the official SDKs `@anthropic-ai/sdk@0.133.0`, `@google/genai@2.28.0` and `openai@7.32.0` (models list only), streamed and not; `curl`-equivalent raw checks of headers and the SSE byte framing; CLI `serve`/`token`/`status`/`login` (fake `xdg-open`)/`account`/`quota`/`models`; SIGTERM drain. |
| live | `tests/live` stays empty until P0-LIVE; the live tier remains INCOMPLETE. |

The three SDK versions are the npm `latest` as of 2026-10-10. They are pinned exactly as devDependencies of `apps/router` and added to AGENTS.md §6.

## 4. Risk R1: the e2e coverage law
AGENTS §5 requires e2e **alone** to reach 100% of every source file, including the defensive branches (for example `writeJsonAtomic`'s failed temp-file cleanup, or `FileLock` losing a race while inspecting a lock file). Many branches can be reached black-box (file-system states, the fake `xdg-open`, replay servers sending error statuses). Some may not be reachable without code seams that exist only for e2e.

**Approach:** build the e2e tier as far as black-box allows, measure it, then report **every** e2e-uncovered branch with its reason and the options. Nothing gets an exclusion, and AGENTS §5 is not changed without your decision.

## 5. Order of work (each step: tests at 100% before the next)
1. Core additions: `HttpRequest.signal`, the `ModelsSource` type, and the dialect error codes.
2. Claude F4 (beta merge with the known-name rule) plus `anthropic-version` check.
3. Antigravity: the runner refactor (behaviour-preserving, with the existing tests unchanged and green), `AntigravityNativePort`, the request validator/mapper, the turn view, and the response unwrapping and aggregation.
4. Router: auth guard, token store, the route table, the HTTP adapter, the dialect encoders, the models endpoints with their source, and the CLI `serve`/`token`/`status`.
5. Composition: the upstream seams (loopback-only) and wiring.
6. e2e harness (replay upstreams, fake `xdg-open`, the SDK suites), then the coverage measurement and the R1 report.
7. Docs: README (client how-to for both native cells), AGENTS (pins, routes), the diagram, the session record. Then `verify`, commit and push.

## 6. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| Q1 | Approve this P4 scope and order? | Yes |
| Q2 | Tool-schema keywords outside the law-5 whitelist on the Gemini cell: 400 by default (strict law), sanitized only with `x-router-lossy: 1`? | **Yes, strict.** The plugin sanitized silently because its only client was OpenCode; a general router must not alter tools without saying so. |
| Q3 | Wire-law drops on the Gemini cell (law 6 unsigned calls, law 8 empty contents, law 12 trailing model turns): applied always, because they are upstream constraints that must never regress (AGENTS §3), **and** reported in `x-router-dropped` even without the lossy header? | **Yes.** The laws stay; reporting them means nothing is removed silently. |
| Q4 | `:generateContent` (non-streamed) on Antigravity, which only streams: build one response by concatenating consecutive text parts with the same `thought` flag, keeping `functionCall` parts and their `thoughtSignature` in order, the last `finishReason` and the last `usageMetadata`? | **Yes**, with the rule written as a pure function, tested against the plugin's stream captures, and re-checked against a real non-streamed comparison in P0-LIVE. |
| Q5 | Antigravity models have no creation date or version (SPEC §4 catalog fields). Anthropic `created_at` / OpenAI `created` are required fields, and Gemini `version`/`baseModelId` too. | **Use a neutral marker, never an invented date:** Anthropic `created_at: "1970-01-01T00:00:00Z"`, OpenAI `created: 0`, Gemini `baseModelId` = the wire id and `version: "antigravity"`. These are clearly not real dates; the README documents them. The alternative is to omit the fields, which breaks strict SDK parsers. |

## 7. Amendment B: changes from the P0-LIVE evidence (2026-10-11)

Source: [P0-LIVE findings](../reference/2026-10-10-23-17-p0-live-findings.md) (L1–L15), [E3 matrix](../reference/2026-10-10-23-17-fidelity-matrix.md).

| Change | Finding | Effect on this plan |
|---|---|---|
| B1 | L6 | §2.3 request mapping: `toolConfig.functionCallingConfig.mode` other than `AUTO`/`VALIDATED`, and `allowedFunctionNames`, → 400 `unsupported_feature` (upstream ignores or rejects them). Lossy drops them and reports it. |
| B2 | L10 | §2.1 Gemini error shape: taken from the E3 captures (`{"error":{"code","message","status"}}`), not from the plugin. |
| B3 | L12 | §2.1 / step 1: `HttpRequest` gains an explicit idle timeout; `FetchTransport` passes Bun's `timeout` (idle) and the abort signal; an upstream timeout becomes 504 in the dialect's shape. |
| B4 | L13 | §2.4 README: the Antigravity list is the upstream catalog minus wire-law-9 ids; it can include IDE helper models such as `tab_*`. |
| B5 | L4 | README: Claude stop sequences also match inside thinking. |
| B6 | L1–L3 | Decision Q6 below. |
| B7 | L5 | Decision Q7 below. |

| # | Question | Recommendation |
|---|---|---|
| Q6 | Claude thinking. Today a request **without** `thinking` gets Claude Code's default (enabled, budget 31,999), so a small `max_tokens` returns an empty answer (L1), and a request **with** `thinking: disabled` fails 400 because the envelope always adds `context_management` clear-thinking (L2), which also makes forced `tool_choice` and non-default sampling impossible (L3). | **Honour the client.** `thinking` absent stays absent and `disabled` stays `disabled`, and in both cases the clear-thinking `context_management` edit is left out; an explicit `enabled`/`adaptive` keeps today's envelope. **Probed live 2026-10-11** ([Q6 probe](../reference/2026-10-10-23-20-q6-thinking-probe.md)): `disabled` without the edit → 200 "OK"; absent without the edit → 200 "OK"; `disabled` + `tool_choice: any` + `temperature: 0` → 200 with a forced `get_time` call. |
| Q7 | Fingerprints say Windows while the router runs on Linux (L5). Both upstreams accept them. | **Keep them verbatim.** They are the only captured values (the Linux machine has Claude Code 2.1.29, not the captured 2.1.280, and no Antigravity IDE capture). Changing them would be guessing. Revisit only with a real Linux capture. |

## 8. Execution record (2026-10-11)

Steps 1–7 are built; commits `3a1d131` (steps 1–5) and the e2e/docs commit after it.

| Step | Result |
|---|---|
| 1 Core | `RawRequest` query/lossy/signal, `HttpRequest` idle timeout + signal, new errors, `ModelCatalog` with source and native dialect, Google error envelope (`docs/reference/specs/google-rpc-code.proto` fetched), constant-time equality, inbound ports Access/Health/DaemonStatus/DialectCodec/ErrorReporter |
| 2 Claude | F4 beta merge + `anthropic-version` check; F9 (Q6) thinking honoured, parity tests normalized and the difference asserted |
| 3 Antigravity | shared `AntigravityRunner` (chat moved onto it, its tests unchanged), `AntigravityNative`, the Gemini validator/mapper with B1/Q2/Q3, framing, `generateContent` merge (Q4), `countTokens` 400 |
| 4 Router | route table and token carriers, node:http server (32 MB limit, backpressure, abort, drain), CLI `serve`/`token`/`status`, explicit fetch idle timeout (504 on timeout) |
| 5 Composition | loopback-only upstream seams |
| 6 e2e | 21 tests (CLI, daemon with the three SDKs, bundle); measured e2e-alone coverage 73.16% statements / 54.64% branches — risk R1, [report](../reference/2026-10-11-11-43-p4-e2e-coverage-r1.md) |
| live | the real daemon on the router's own accounts answered every P4 route (Anthropic messages plain and streamed — Q6 live: no thinking, "OK"; Gemini generateContent and SSE; the three model lists, 46 models): [smoke](../reference/2026-10-11-11-47-p4-live-daemon-smoke.md) |
| 7 Docs | README (daemon how-to, routes, headers, notes), AGENTS (laws, seams, e2e, pins), diagram, this record |
| R1 | user chose option B (2026-10-11). Result: e2e alone 100% on every metric (177 tests, 11 named P5 deferrals), unit+component 100% (497 tests), merged 100%; `bun run verify` **GATE: PASS**. Two defects found and fixed (signature-store write race; replay server idle limit), five hermetic hooks: [resolution](../reference/2026-10-11-11-43-p4-e2e-coverage-r1.md#5-resolution-option-b-user-decision-2026-10-11-measured-2026-10-11) |

Deviations, each stated in the code or docs where it applies:
- e2e runs the source entry under the coverage preload; the bundle (plan §3) is smoke-tested separately because a bundle cannot carry per-source instrumentation.
- The router token is stored as `token.json` (`{"token": …}`) instead of a raw `token` file, reusing the atomic BOM-tolerant JSON store.
- Gemini `baseModelId` is the routable `<provider>/<model>` (Q5 said the wire id); the spec says to pass it to the generation request, and only the routable id works there.
- The constant-time comparison is a pure-TypeScript XOR over SHA-256 digests (same contract as `crypto.timingSafeEqual`), so the application layer has no runtime import.
- Bun 1.4.2's `closeAllConnections` leaves a connection with an unfinished response open (measured); stop destroys the tracked sockets after the grace period instead.
- Bun fetch's `timeout` (idle) fired after ~8 s for a 1 s setting in a probe; the router's 10-minute value is far above that granularity.
