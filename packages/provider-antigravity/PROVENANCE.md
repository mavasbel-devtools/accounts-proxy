# provider-antigravity provenance

**Source:** `opencode-antigravity-auth` @ `5c6f7c2697fdc187bfc1d5f0208b8f5563620875`. Its `src/` working tree was clean at extraction (2026-10-07).

**Parity reference:** `tests/reference/plugin-5c6f7c2/` was exported with `scripts/evidence/vendor-reference.ts`. The only edit is rewriting the `@antigravity/` alias into relative paths. Source blob ids are in `MANIFEST.json`.

**Fixtures:** `tests/fixtures/plugin-5c6f7c2/` was exported byte-exact with `scripts/evidence/export-files.ts` from `test/fixtures/capture/`. Blobs:
- `745cb4e6`: quota summary
- `180d7a4e`: available models
- `12e3b283`: stream

## File mapping

| Router file | Source |
|---|---|
| `src/domain/constants.ts` | `infrastructure/config/PluginConfig.ts`, `AntigravityApiClientAdapter.ts` (IDE metadata), `LoopbackCallbackServerAdapter.ts` (success redirect), `ModelCatalogService.ts` (80k cap), `StreamChatUseCase.ts` (geo backoff), `SignatureStoreAdapter.ts` (2000 cap) |
| `src/domain/account.ts` | `domain/entities/Account.ts`, `RefreshSessionUseCase.ensureFresh` (rotation keeps the refresh token), `ProjectResolver.pickActiveProject` |
| `src/domain/project.ts` | `domain/services/ProjectResolver.ts`, `AntigravityApiClientAdapter.onboardUser` (project extraction) |
| `src/domain/catalog.ts` | `domain/services/ModelCatalogService.ts`, `ResolveModelsUseCase` (`descriptorToEntry` limit rule, `wireDefaults`) |
| `src/domain/quota.ts` | `domain/services/QuotaService.ts`, `domain/entities/QuotaSnapshot.ts` |
| `src/domain/trajectory.ts` | `domain/services/TrajectoryStateService.ts` |
| `src/domain/generate.ts` | `domain/services/RequestTransformService.ts`, plus the `ChatRequest`/`ChatChunk`/`StreamEnvelope` port types |
| `src/domain/upstream.ts` | `AntigravityApiClientAdapter.ts` (outer envelope, non-response law), `StreamChatUseCase.ts` (geo gate) |
| `src/adapters/outbound/antigravity-api-client.ts` | `AntigravityApiClientAdapter.ts` |
| `src/adapters/outbound/google-oauth-client.ts` | `GoogleOAuthClientAdapter.ts`, `LoginUseCase.buildAccount` |
| `src/adapters/outbound/antigravity-session.ts`, `with-active.ts` | `RefreshSessionUseCase.ts` (`refreshedActive`, `withActiveTokens`, `forceRotate`) |
| `src/adapters/outbound/antigravity-state.ts` | `DeviceIdentityStoreAdapter.ts`, `SignatureStoreAdapter.ts` |
| `src/adapters/outbound/antigravity-catalog.ts` | `ResolveModelsUseCase.ts` |
| `src/adapters/outbound/antigravity-quota.ts` | `QuotaReportUseCase.ts` |
| `src/adapters/outbound/antigravity-chat.ts` | `StreamChatUseCase.ts` |
| `src/adapters/outbound/antigravity-provider.ts` | new (`ProviderPort`); limits per `descriptorToEntry` |

**Not carried over:**
- **OpenCode-specific code:** the v1/v2 host adapters, the TUI, `tui.json` registration, the OpenAI relay (ported in P5 onto the dialect codecs), and the `auth.json` mirror and host-mirror bootstrap. The router never reads foreign stores (plan D5).
- **Automatic account switching:** the pool's enable/cooldown state and `withCooldown` are dropped. Accounts are only switched manually (plan D4).

## Deliberate differences

Every difference is pinned by a test.

| Id | Difference | Why | Test |
|---|---|---|---|
| G2 | Token refresh runs once per process at a time, under a cross-process lock that re-reads the pool first; `forceRotate` reuses a token another caller already rotated | Concurrent refreshes could spend or invalidate the refresh token | `adapters.test.ts` AntigravitySession |
| G5 | Chat refreshes the token ahead of expiry before calling | Source `StreamChatUseCase` used bare `loadActive`, breaking its own token lifecycle law | `adapters.test.ts` "G5" |
| G6 | 429 becomes `quota_exhausted` carrying the `Retry-After` delta-seconds; no account rotation | Plan D4 | `domain.test.ts` upstream, `adapters.test.ts` api client |
| A1 | SSE decoded with the WHATWG `SseCodec`. For the captured format (one `data:` line per event) the envelopes are identical | One framing implementation for the whole router | `adapters.test.ts` captured stream |
| A2 | A non-response 200 payload or malformed JSON stream becomes `upstream_error` HTTP 502, body kept. Source: `ProtocolError(200)` | The client is told the upstream answered, but not with a generation | `domain.test.ts` upstream |
| A3 | The chat 401 retry also requires that nothing has been yielded yet | Prevents double output. The upstream status is checked before streaming, so this has no observable effect today | `adapters.test.ts` "401" |
| A4 | A stored session id is used only if it is a valid signed int64 decimal string; otherwise a new one is minted | Hardening for corrupt storage | `domain.test.ts` `isSessionId`, `adapters.test.ts` state |
| A5 | Window labels in the usage view are looked up only as own properties (`toString` is not a label) | Same defect class as provider-claude F8 | `domain.test.ts` quota |

## Waiting on P0-LIVE evidence

These are not implemented, and nothing is assumed about them:
- **Native Gemini cell mapping:** user-role vs model-role `functionResponse`, response unwrapping, and non-stream `generateContent`. Until then `passthrough` and the translated cells answer `unsupported_feature`.
- **Quota inside a 200/other body:** classified only via HTTP 429 until a real payload is captured.
- **`RetryInfo` in the body:** only the `Retry-After` header is read.
