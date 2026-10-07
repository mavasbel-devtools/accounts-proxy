# Evidence: alias imports (plan docs/plans/2026-10-07-00-31-alias-imports-plan.md)

Captured 2026-10-07 with Bun 1.4.2 and TypeScript 5.9.3. Base commit: `89cb5f5`.

## Inventory

| Area | Before (relative) | After (relative) | After (`@inference-router/…`) |
|---|---:|---:|---:|
| sources | 115 (+122 already aliased) | 0 | 237 |
| tests | 94 + 31 crossing workspaces | 0 | 125 |
| scripts | 10 | 0 | 10 |
| vendored references | 14 (rewritten copies) | 0 (byte-identical, plugin aliases via nested tsconfig) | — |

Produced by `docs/temp/count-imports.ts` (`ts.preProcessFile` over every `.ts`).

## Mechanical-change proof

`bun scripts/evidence/verify-alias-diff.ts 89cb5f5 <codemod log> --allow packages/provider-claude/tests/component/parity.test.ts:20`:

```text
ALLOWED non-import change packages/provider-claude/tests/component/parity.test.ts:20
69 files; 250/250 logged rewrites verified; 1 allowed exceptions; 0 failures
```

The one allowed line is the Claude parity test's reference path, which moved because the reference is now
stored under the plugin's own source paths (`domain/services/RequestTransformService.ts`).

## Byte-identical vendored references

`scripts/evidence/vendor-reference.ts` checks each written file with `git hash-object --no-filters` against
the source blob. Result: antigravity 10 files, 0 mismatches; claude 4 files, 0 mismatches. Both
`MANIFEST.json` files list the blobs.

## Gate after the change

- `bun run verify`: typecheck PASS; unit+component+arch PASS, 342 tests, 100% statements 1545/1545, branches
  1162/1162, functions 347/347, lines 1276/1276 (identical totals to the pre-change run, so the instrumented set of
  files is unchanged); build PASS; e2e and merged INCOMPLETE (no e2e tier yet); docs lint PASS.
- Alias-law mutation check: a relative import injected into `packages/core/tests/unit/ports.test.ts` made the
  architecture gate fail with that exact violation (exit 1); the file was restored byte-identical.

## Codemod log (`bun scripts/evidence/alias-imports.ts`)

```text
apps/router/src/adapters/inbound/cli/cli-driver.ts: ../driver.ts -> @inference-router/router/adapters/inbound/driver.ts
apps/router/src/composition/container.ts: ../adapters/inbound/cli/cli-driver.ts -> @inference-router/router/adapters/inbound/cli/cli-driver.ts
apps/router/src/composition/container.ts: ../adapters/inbound/driver.ts -> @inference-router/router/adapters/inbound/driver.ts
apps/router/src/composition/container.ts: ../adapters/outbound/browser-launcher.ts -> @inference-router/router/adapters/outbound/browser-launcher.ts
apps/router/src/composition/container.ts: ../adapters/outbound/fetch-transport.ts -> @inference-router/router/adapters/outbound/fetch-transport.ts
apps/router/src/composition/container.ts: ../adapters/outbound/file-lock.ts -> @inference-router/router/adapters/outbound/file-lock.ts
apps/router/src/composition/container.ts: ../adapters/outbound/file-stores.ts -> @inference-router/router/adapters/outbound/file-stores.ts
apps/router/src/composition/container.ts: ../adapters/outbound/loopback-callback-server.ts -> @inference-router/router/adapters/outbound/loopback-callback-server.ts
apps/router/src/composition/container.ts: ../adapters/outbound/system.ts -> @inference-router/router/adapters/outbound/system.ts
apps/router/src/composition/container.ts: ../adapters/outbound/terminal-manual-code.ts -> @inference-router/router/adapters/outbound/terminal-manual-code.ts
apps/router/src/composition/container.ts: ../adapters/outbound/yaml-config-file.ts -> @inference-router/router/adapters/outbound/yaml-config-file.ts
apps/router/src/composition/container.ts: ../application/account-services.ts -> @inference-router/router/application/account-services.ts
apps/router/src/composition/container.ts: ../application/list-models-service.ts -> @inference-router/router/application/list-models-service.ts
apps/router/src/composition/container.ts: ../application/login-service.ts -> @inference-router/router/application/login-service.ts
apps/router/src/main/cli.ts: ../composition/container.ts -> @inference-router/router/composition/container.ts
apps/router/tests/component/adapters.test.ts: ../../../../packages/core/src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
apps/router/tests/component/adapters.test.ts: ../../../../packages/core/src/domain/config.ts -> @inference-router/core/domain/config.ts
apps/router/tests/component/adapters.test.ts: ../../../../packages/core/src/domain/services/base64url.ts -> @inference-router/core/domain/services/base64url.ts
apps/router/tests/component/adapters.test.ts: ../../../../packages/core/src/domain/wire.ts -> @inference-router/core/domain/wire.ts
apps/router/tests/component/adapters.test.ts: ../../../../tests/support/fakes.ts -> @inference-router/test-support/fakes.ts
apps/router/tests/component/adapters.test.ts: ../../../../tests/support/temporary.ts -> @inference-router/test-support/temporary.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/browser-launcher.ts -> @inference-router/router/adapters/outbound/browser-launcher.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/fetch-transport.ts -> @inference-router/router/adapters/outbound/fetch-transport.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/file-lock.ts -> @inference-router/router/adapters/outbound/file-lock.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/file-stores.ts -> @inference-router/router/adapters/outbound/file-stores.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/loopback-callback-server.ts -> @inference-router/router/adapters/outbound/loopback-callback-server.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/system.ts -> @inference-router/router/adapters/outbound/system.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/terminal-manual-code.ts -> @inference-router/router/adapters/outbound/terminal-manual-code.ts
apps/router/tests/component/adapters.test.ts: ../../src/adapters/outbound/yaml-config-file.ts -> @inference-router/router/adapters/outbound/yaml-config-file.ts
apps/router/tests/component/container.test.ts: ../../../../packages/core/src/domain/wire.ts -> @inference-router/core/domain/wire.ts
apps/router/tests/component/container.test.ts: ../../../../packages/core/src/ports/outbound/system.ts -> @inference-router/core/ports/outbound/system.ts
apps/router/tests/component/container.test.ts: ../../../../tests/support/fakes.ts -> @inference-router/test-support/fakes.ts
apps/router/tests/component/container.test.ts: ../../../../tests/support/temporary.ts -> @inference-router/test-support/temporary.ts
apps/router/tests/component/container.test.ts: ../../src/composition/container.ts -> @inference-router/router/composition/container.ts
apps/router/tests/component/container.test.ts: ../../src/main/cli.ts -> @inference-router/router/main/cli.ts
apps/router/tests/component/container.test.ts: ../../src/composition/container.ts -> @inference-router/router/composition/container.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/domain/errors.ts -> @inference-router/core/domain/errors.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/domain/models.ts -> @inference-router/core/domain/models.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/ports/outbound/oauth.ts -> @inference-router/core/ports/outbound/oauth.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/ports/outbound/provider.ts -> @inference-router/core/ports/outbound/provider.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/ports/outbound/system.ts -> @inference-router/core/ports/outbound/system.ts
apps/router/tests/unit/application.test.ts: ../../../../packages/core/src/ports/outbound/usage.ts -> @inference-router/core/ports/outbound/usage.ts
apps/router/tests/unit/application.test.ts: ../../../../tests/support/fakes.ts -> @inference-router/test-support/fakes.ts
apps/router/tests/unit/application.test.ts: ../../src/application/account-services.ts -> @inference-router/router/application/account-services.ts
apps/router/tests/unit/application.test.ts: ../../src/application/list-models-service.ts -> @inference-router/router/application/list-models-service.ts
apps/router/tests/unit/application.test.ts: ../../src/application/login-service.ts -> @inference-router/router/application/login-service.ts
apps/router/tests/unit/cli-driver.test.ts: ../../../../packages/core/src/domain/errors.ts -> @inference-router/core/domain/errors.ts
apps/router/tests/unit/cli-driver.test.ts: ../../../../packages/core/src/domain/models.ts -> @inference-router/core/domain/models.ts
apps/router/tests/unit/cli-driver.test.ts: ../../../../packages/core/src/ports/inbound/accounts.ts -> @inference-router/core/ports/inbound/accounts.ts
apps/router/tests/unit/cli-driver.test.ts: ../../../../packages/core/src/ports/inbound/routing.ts -> @inference-router/core/ports/inbound/routing.ts
apps/router/tests/unit/cli-driver.test.ts: ../../src/adapters/inbound/cli/cli-driver.ts -> @inference-router/router/adapters/inbound/cli/cli-driver.ts
apps/router/tests/unit/cli-driver.test.ts: ../../src/adapters/inbound/driver.ts -> @inference-router/router/adapters/inbound/driver.ts
packages/core/src/domain/accounts.ts: ./errors.ts -> @inference-router/core/domain/errors.ts
packages/core/src/domain/accounts.ts: ./json.ts -> @inference-router/core/domain/json.ts
packages/core/src/domain/accounts.ts: ./models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/canonical/events.ts: ../errors.ts -> @inference-router/core/domain/errors.ts
packages/core/src/domain/canonical/parts.ts: ../json.ts -> @inference-router/core/domain/json.ts
packages/core/src/domain/canonical/parts.ts: ../models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/canonical/request.ts: ../json.ts -> @inference-router/core/domain/json.ts
packages/core/src/domain/canonical/request.ts: ../models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/canonical/request.ts: ./parts.ts -> @inference-router/core/domain/canonical/parts.ts
packages/core/src/domain/config.ts: ./json.ts -> @inference-router/core/domain/json.ts
packages/core/src/domain/config.ts: ./models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/config.ts: ./services/model-address.ts -> @inference-router/core/domain/services/model-address.ts
packages/core/src/domain/errors.ts: ./models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/services/feature-support.ts: ../canonical/request.ts -> @inference-router/core/domain/canonical/request.ts
packages/core/src/domain/services/feature-support.ts: ../canonical/parts.ts -> @inference-router/core/domain/canonical/parts.ts
packages/core/src/domain/services/feature-support.ts: ../errors.ts -> @inference-router/core/domain/errors.ts
packages/core/src/domain/services/model-address.ts: ../errors.ts -> @inference-router/core/domain/errors.ts
packages/core/src/domain/services/model-address.ts: ../models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/services/oauth-flow.ts: ../errors.ts -> @inference-router/core/domain/errors.ts
packages/core/src/domain/services/oauth-flow.ts: ../models.ts -> @inference-router/core/domain/models.ts
packages/core/src/domain/services/usage.ts: ../canonical/events.ts -> @inference-router/core/domain/canonical/events.ts
packages/core/src/ports/inbound/accounts.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/inbound/accounts.ts: ../../domain/usage.ts -> @inference-router/core/domain/usage.ts
packages/core/src/ports/inbound/routing.ts: ../../domain/canonical/events.ts -> @inference-router/core/domain/canonical/events.ts
packages/core/src/ports/inbound/routing.ts: ../../domain/canonical/request.ts -> @inference-router/core/domain/canonical/request.ts
packages/core/src/ports/inbound/routing.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/inbound/routing.ts: ../../domain/services/feature-support.ts -> @inference-router/core/domain/services/feature-support.ts
packages/core/src/ports/inbound/routing.ts: ../../domain/wire.ts -> @inference-router/core/domain/wire.ts
packages/core/src/ports/outbound/credentials.ts: ../../domain/accounts.ts -> @inference-router/core/domain/accounts.ts
packages/core/src/ports/outbound/credentials.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/outbound/oauth.ts: ../../domain/accounts.ts -> @inference-router/core/domain/accounts.ts
packages/core/src/ports/outbound/oauth.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/outbound/provider.ts: ../../domain/canonical/events.ts -> @inference-router/core/domain/canonical/events.ts
packages/core/src/ports/outbound/provider.ts: ../../domain/canonical/request.ts -> @inference-router/core/domain/canonical/request.ts
packages/core/src/ports/outbound/provider.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/outbound/provider.ts: ../../domain/services/feature-support.ts -> @inference-router/core/domain/services/feature-support.ts
packages/core/src/ports/outbound/provider.ts: ../../domain/wire.ts -> @inference-router/core/domain/wire.ts
packages/core/src/ports/outbound/state.ts: ../../domain/json.ts -> @inference-router/core/domain/json.ts
packages/core/src/ports/outbound/transport.ts: ../../domain/wire.ts -> @inference-router/core/domain/wire.ts
packages/core/src/ports/outbound/usage.ts: ../../domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/src/ports/outbound/usage.ts: ../../domain/usage.ts -> @inference-router/core/domain/usage.ts
packages/core/tests/unit/config-and-oauth.test.ts: ../../src/domain/config.ts -> @inference-router/core/domain/config.ts
packages/core/tests/unit/config-and-oauth.test.ts: ../../src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/core/tests/unit/config-and-oauth.test.ts: ../../src/domain/services/oauth-flow.ts -> @inference-router/core/domain/services/oauth-flow.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/json.ts -> @inference-router/core/domain/json.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/models.ts -> @inference-router/core/domain/models.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/services/base64url.ts -> @inference-router/core/domain/services/base64url.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/services/model-address.ts -> @inference-router/core/domain/services/model-address.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/services/usage.ts -> @inference-router/core/domain/services/usage.ts
packages/core/tests/unit/domain.test.ts: ../../src/domain/wire.ts -> @inference-router/core/domain/wire.ts
packages/core/tests/unit/event-stream.test.ts: ../../src/domain/services/event-stream.ts -> @inference-router/core/domain/services/event-stream.ts
packages/core/tests/unit/feature-support.test.ts: ../../src/domain/canonical/request.ts -> @inference-router/core/domain/canonical/request.ts
packages/core/tests/unit/feature-support.test.ts: ../../src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/core/tests/unit/feature-support.test.ts: ../../src/domain/services/feature-support.ts -> @inference-router/core/domain/services/feature-support.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/inbound/accounts.ts -> @inference-router/core/ports/inbound/accounts.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/inbound/routing.ts -> @inference-router/core/ports/inbound/routing.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/credentials.ts -> @inference-router/core/ports/outbound/credentials.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/oauth.ts -> @inference-router/core/ports/outbound/oauth.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/provider.ts -> @inference-router/core/ports/outbound/provider.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/system.ts -> @inference-router/core/ports/outbound/system.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/state.ts -> @inference-router/core/ports/outbound/state.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/usage.ts -> @inference-router/core/ports/outbound/usage.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/oauth.ts -> @inference-router/core/ports/outbound/oauth.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/inbound/accounts.ts -> @inference-router/core/ports/inbound/accounts.ts
packages/core/tests/unit/ports.test.ts: ../../src/ports/outbound/transport.ts -> @inference-router/core/ports/outbound/transport.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-api-client.ts: ../../domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-api-client.ts: ../../domain/constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-api-client.ts: ../../domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-api-client.ts: ../../domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-api-client.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-catalog.ts: ../../domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-catalog.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-catalog.ts: ./with-active.ts -> @inference-router/provider-antigravity/adapters/outbound/with-active.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../domain/constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../domain/trajectory.ts -> @inference-router/provider-antigravity/domain/trajectory.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-provider.ts: ../../domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-provider.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-quota.ts: ../../domain/quota.ts -> @inference-router/provider-antigravity/domain/quota.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-quota.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-quota.ts: ./with-active.ts -> @inference-router/provider-antigravity/adapters/outbound/with-active.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-session.ts: ../../domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-session.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-state.ts: ../../domain/constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-state.ts: ../../domain/trajectory.ts -> @inference-router/provider-antigravity/domain/trajectory.ts
packages/provider-antigravity/src/adapters/outbound/antigravity-state.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/google-oauth-client.ts: ../../domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/src/adapters/outbound/google-oauth-client.ts: ../../domain/constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/adapters/outbound/google-oauth-client.ts: ../../domain/project.ts -> @inference-router/provider-antigravity/domain/project.ts
packages/provider-antigravity/src/adapters/outbound/google-oauth-client.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/adapters/outbound/with-active.ts: ../../domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-antigravity/src/adapters/outbound/with-active.ts: ../../ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/src/domain/account.ts: ./constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/domain/catalog.ts: ./constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/src/domain/generate.ts: ./trajectory.ts -> @inference-router/provider-antigravity/domain/trajectory.ts
packages/provider-antigravity/src/domain/trajectory.ts: ./generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/src/domain/upstream.ts: ./generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/src/ports/outbound/antigravity.ts: ../../domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/src/ports/outbound/antigravity.ts: ../../domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/src/ports/outbound/antigravity.ts: ../../domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/src/ports/outbound/antigravity.ts: ../../domain/quota.ts -> @inference-router/provider-antigravity/domain/quota.ts
packages/provider-antigravity/src/ports/outbound/antigravity.ts: ../../domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../../core/src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../../core/src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../../core/src/ports/outbound/system.ts -> @inference-router/core/ports/outbound/system.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../../../tests/support/fakes.ts -> @inference-router/test-support/fakes.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-api-client.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-api-client.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-catalog.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-catalog.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-chat.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-chat.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-provider.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-provider.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-quota.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-quota.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-session.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-session.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/antigravity-state.ts -> @inference-router/provider-antigravity/adapters/outbound/antigravity-state.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/google-oauth-client.ts -> @inference-router/provider-antigravity/adapters/outbound/google-oauth-client.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/adapters/outbound/with-active.ts -> @inference-router/provider-antigravity/adapters/outbound/with-active.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/domain/constants.ts -> @inference-router/provider-antigravity/domain/constants.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/ports/outbound/antigravity.ts -> @inference-router/provider-antigravity/ports/outbound/antigravity.ts
packages/provider-antigravity/tests/component/adapters.test.ts: ../../src/domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/tests/component/parity.test.ts: ../../src/domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/tests/component/parity.test.ts: ../../src/domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/tests/component/parity.test.ts: ../../src/domain/project.ts -> @inference-router/provider-antigravity/domain/project.ts
packages/provider-antigravity/tests/component/parity.test.ts: ../../src/domain/quota.ts -> @inference-router/provider-antigravity/domain/quota.ts
packages/provider-antigravity/tests/component/parity.test.ts: ../../src/domain/trajectory.ts -> @inference-router/provider-antigravity/domain/trajectory.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../../core/src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/account.ts -> @inference-router/provider-antigravity/domain/account.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/catalog.ts -> @inference-router/provider-antigravity/domain/catalog.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/generate.ts -> @inference-router/provider-antigravity/domain/generate.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/project.ts -> @inference-router/provider-antigravity/domain/project.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/quota.ts -> @inference-router/provider-antigravity/domain/quota.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/trajectory.ts -> @inference-router/provider-antigravity/domain/trajectory.ts
packages/provider-antigravity/tests/unit/domain.test.ts: ../../src/domain/upstream.ts -> @inference-router/provider-antigravity/domain/upstream.ts
packages/provider-claude/src/adapters/outbound/claude-catalog.ts: ../../domain/catalog.ts -> @inference-router/provider-claude/domain/catalog.ts
packages/provider-claude/src/adapters/outbound/claude-catalog.ts: ../../domain/constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/src/adapters/outbound/claude-catalog.ts: ../../domain/model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/src/adapters/outbound/claude-catalog.ts: ../../ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/src/adapters/outbound/claude-identity.ts: ../../ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/src/adapters/outbound/claude-oauth-client.ts: ../../domain/constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/src/adapters/outbound/claude-oauth-client.ts: ../../domain/credential.ts -> @inference-router/provider-claude/domain/credential.ts
packages/provider-claude/src/adapters/outbound/claude-oauth-client.ts: ../../ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/src/adapters/outbound/claude-session.ts: ../../domain/credential.ts -> @inference-router/provider-claude/domain/credential.ts
packages/provider-claude/src/adapters/outbound/claude-session.ts: ../../ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/src/adapters/outbound/claude-subscription-provider.ts: ../../domain/constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/src/adapters/outbound/claude-subscription-provider.ts: ../../domain/request-transform.ts -> @inference-router/provider-claude/domain/request-transform.ts
packages/provider-claude/src/adapters/outbound/claude-subscription-provider.ts: ../../ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/src/domain/catalog.ts: ./model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/src/domain/credential.ts: ./constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/src/domain/request-transform.ts: ./constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/src/domain/request-transform.ts: ./model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/src/ports/outbound/claude.ts: ../../domain/credential.ts -> @inference-router/provider-claude/domain/credential.ts
packages/provider-claude/src/ports/outbound/claude.ts: ../../domain/model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../../core/src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../../core/src/domain/errors.ts -> @inference-router/core/domain/errors.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../../core/src/domain/wire.ts -> @inference-router/core/domain/wire.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../../../tests/support/fakes.ts -> @inference-router/test-support/fakes.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/adapters/outbound/claude-catalog.ts -> @inference-router/provider-claude/adapters/outbound/claude-catalog.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/adapters/outbound/claude-identity.ts -> @inference-router/provider-claude/adapters/outbound/claude-identity.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/adapters/outbound/claude-oauth-client.ts -> @inference-router/provider-claude/adapters/outbound/claude-oauth-client.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/adapters/outbound/claude-session.ts -> @inference-router/provider-claude/adapters/outbound/claude-session.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/adapters/outbound/claude-subscription-provider.ts -> @inference-router/provider-claude/adapters/outbound/claude-subscription-provider.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/domain/constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/domain/credential.ts -> @inference-router/provider-claude/domain/credential.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/domain/model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/tests/component/adapters.test.ts: ../../src/ports/outbound/claude.ts -> @inference-router/provider-claude/ports/outbound/claude.ts
packages/provider-claude/tests/component/parity.test.ts: ../../src/domain/request-transform.ts -> @inference-router/provider-claude/domain/request-transform.ts
packages/provider-claude/tests/component/parity.test.ts: ../../src/domain/model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/tests/unit/domain.test.ts: ../../src/domain/catalog.ts -> @inference-router/provider-claude/domain/catalog.ts
packages/provider-claude/tests/unit/domain.test.ts: ../../src/domain/constants.ts -> @inference-router/provider-claude/domain/constants.ts
packages/provider-claude/tests/unit/domain.test.ts: ../../src/domain/credential.ts -> @inference-router/provider-claude/domain/credential.ts
packages/provider-claude/tests/unit/domain.test.ts: ../../src/domain/model-envelope.ts -> @inference-router/provider-claude/domain/model-envelope.ts
packages/provider-claude/tests/unit/domain.test.ts: ../../src/domain/request-transform.ts -> @inference-router/provider-claude/domain/request-transform.ts
scripts/gate/coverage-report.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/e2e-coverage-preload.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/lint-docs.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/merge-coverage.ts: ./coverage-report.ts -> @inference-router/scripts/gate/coverage-report.ts
scripts/gate/merge-coverage.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/merge-coverage.ts: ./run-tests.ts -> @inference-router/scripts/gate/run-tests.ts
scripts/gate/run-tests.ts: ./coverage-report.ts -> @inference-router/scripts/gate/coverage-report.ts
scripts/gate/run-tests.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/unit-coverage-preload.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
scripts/gate/verify.ts: ./instrument.ts -> @inference-router/scripts/gate/instrument.ts
tests/support/fakes.ts: ../../packages/core/src/domain/accounts.ts -> @inference-router/core/domain/accounts.ts
tests/support/fakes.ts: ../../packages/core/src/domain/json.ts -> @inference-router/core/domain/json.ts
tests/support/fakes.ts: ../../packages/core/src/domain/models.ts -> @inference-router/core/domain/models.ts
tests/support/fakes.ts: ../../packages/core/src/domain/wire.ts -> @inference-router/core/domain/wire.ts
tests/support/fakes.ts: ../../packages/core/src/ports/outbound/credentials.ts -> @inference-router/core/ports/outbound/credentials.ts
tests/support/fakes.ts: ../../packages/core/src/ports/outbound/state.ts -> @inference-router/core/ports/outbound/state.ts
tests/support/fakes.ts: ../../packages/core/src/ports/outbound/system.ts -> @inference-router/core/ports/outbound/system.ts
tests/support/fakes.ts: ../../packages/core/src/ports/outbound/transport.ts -> @inference-router/core/ports/outbound/transport.ts
tests/support/temporary.test.ts: ./temporary.ts -> @inference-router/test-support/temporary.ts
rewrote 250 specifiers in 69 files; 0 errors
```
