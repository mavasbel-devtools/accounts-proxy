# provider-claude provenance

**Sources:**
- **Base:** `opencode-claude-auth` @ `62927412322eedfd5b1d8f08c4eb894f26e6c50a`. Its `src/` working tree was clean at extraction time, 2026-10-06/07.
- **Official binary:** Claude Code 2.1.280 (`C:\Users\Marco\.local\bin\claude.exe`), sha256 `0e4195524b73eb77efbdf3e2b36de5322a29f0ca575dfd2d9b4f946b1d425469`, read with `scripts/evidence/scan-binary.ts`.

## File mapping

| Router file | Source |
|---|---|
| `src/domain/constants.ts` | `RequestTransformService.ts` (wire constants), `ClaudeOAuthClientAdapter.ts` (`TOKEN_HEADERS`), `ClaudeCredential.ts` (120 s expiry buffer), AGENTS.md §9 (catalog contract), and the binary's OAuth constants object `a`, `kCr`, `gqe` |
| `src/domain/model-envelope.ts` | `src/domain/services/ModelEnvelope.ts` (blob `ef95776e`); data byte-identical |
| `src/domain/request-transform.ts` | `src/domain/services/RequestTransformService.ts` (blob `f0f2b9e6`): guard L1–L4, envelope, headers, `apiUrl`, sanitizers |
| `src/domain/credential.ts` | `src/domain/entities/ClaudeCredential.ts`, `ClaudeOAuthClientAdapter.ts#post` (response mapping) |
| `src/domain/catalog.ts` | `AnthropicModelsApiAdapter.ts#parseCatalogEntry` and its pagination cursor rule |
| `src/adapters/outbound/claude-oauth-client.ts` | `ClaudeOAuthClientAdapter.ts`, plus the binary's `_Ln` (authorize), `M_r` (exchange) and `handleSuccessRedirect` |
| `src/adapters/outbound/claude-session.ts` | `RefreshSessionUseCase.ts` |
| `src/adapters/outbound/claude-identity.ts` | `IdentityStoreAdapter.ts`, plus the binary's `iD()` and `UR()` (metadata.user_id) |
| `src/adapters/outbound/claude-catalog.ts` | `AnthropicModelsApiAdapter.ts`, `RefreshModelCatalogUseCase.ts`, `CatalogCacheStoreAdapter.ts` (contract) |
| `src/adapters/outbound/claude-subscription-provider.ts` | `AnthropicRelayAdapter.ts`, `AnthropicApiClientAdapter.ts` |

**Not carried over.** Everything specific to OpenCode: the v1/v2 host adapters, the provider registration, the paste-code `authorize()` hook, and writes to `~/.claude/.credentials.json`. The router keeps its own credential store (plan D5).

## Deliberate differences

Every difference is pinned by a test.

| Id | Difference | Evidence | Test |
|---|---|---|---|
| F1 | The upstream response is streamed chunk by chunk. The source awaited `res.text()`. | Source `AnthropicApiClientAdapter.ts:45` | `adapters.test.ts` "F1: … streamed incrementally" |
| F2 | Token refresh is single-flight within a process, and runs under a cross-process `LockPort` with a re-read of the store. | Source `RefreshSessionUseCase.ts:30-49` (no lock) | `adapters.test.ts` ClaudeSession (single flight; another process's refresh reused) |
| F3 | An explicit `thinking.budget_tokens` is passed through unchanged. The source clamped it to ≥ 1024 and floored it. | Source AGENTS.md §8 forbids clamping | `parity.test.ts` "deliberate differences" |
| F4 | Browser login uses the loopback redirect `http://localhost:<port>/callback`. The source supported only paste-code. Authorize scopes add `user:plugins`. | Binary `_Ln`, `M_r`, `kCr` (P0-E6 reference doc) | `adapters.test.ts` ClaudeOAuthClient; `domain.test.ts` constants |
| F7 | `device_id` is 32 random bytes as 64 lowercase hex characters. The source used base64url. | Binary `iD()` regex `/^[0-9a-f]{64}$/` and `UR()` `device_id:iD()` | `adapters.test.ts` ClaudeIdentity |
| F8 | Model lookups use own-property checks: `toString` and similar ids get the fallback envelope. | Source `ModelEnvelope.ts:93` indexes a plain object | `domain.test.ts` "F8" |

## Not changed yet (waiting on evidence)

- **D-4. The client's `anthropic-beta` header is not merged.** On the native cell the router sends exactly the per-model captured beta list, as the source does. The source never forwards client betas (`RequestTransformService.headers` ignores input headers). A merge rule would change the wire, so it is decided only from the P0-LIVE captures (plan amendment A1).
- **Translated cells** (`stream`, `countTokens`) raise `unsupported_feature` until P5. `capabilities()` stays empty until the P0-E3 fidelity matrix exists.

## Response headers returned to the native client

Router decision (not taken from the source): `content-type`, `retry-after`, `request-id` and `anthropic-ratelimit-*`. The source returned only `retry-after` and inferred `content-type`.
