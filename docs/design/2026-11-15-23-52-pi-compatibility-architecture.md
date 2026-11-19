# Architecture design — pi compatibility

Plan: `docs/plans/2026-11-15-23-52-pi-compatibility-plan.md`.
Product design: `docs/design/2026-11-15-23-52-pi-compatibility-product.md` (use cases uc-pi-1 … uc-pi-6, rules P1–P7).

Dependency direction: `adapters → ports → domain` (`AGENTS.md` §2). Every import uses the
`@accounts-proxy/<workspace>/<subpath>.ts` alias. Names below are final and are used unchanged in the code.

## 1. Workspaces

| Workspace | Directory | Status | Role |
|---|---|---|---|
| `@accounts-proxy/core` | `packages/core` | edited | shared format choice and provider names (domain), `ClientOrigin` and `PiConfigPort` (ports/inbound) |
| `@accounts-proxy/dialect-opencode` | `packages/dialect-opencode` | edited | uses the shared format choice and names; behaviour unchanged |
| `@accounts-proxy/dialect-pi` | `packages/dialect-pi` | new | `PiConfigCodec`: the pi configuration and the well-known manifest |
| `@accounts-proxy/proxy` | `apps/proxy` | edited | routes `GET /pi/models.json`, `GET /.well-known/pi`; command `pi-config`; wiring |
| `@accounts-proxy/pi-extension` | `apps/pi-extension` | new | the pi extension: discovery, token, registration |
| `@accounts-proxy/test-support` | `tests/support` | edited | JSON Schema checker gains the keywords pi's schema uses |
| `@accounts-proxy/scripts` | `scripts` | edited | `fetch-specs` row for pi's schema; granularity report; verify step |

## 2. `packages/core`

### 2.1 Domain — `packages/core/src/domain/client-connection.ts` (serves P1, P2; uc-pi-1)

| Name | Responsibility |
|---|---|
| `AISDK_FORMAT` | the reference AI SDK package → the proxy format it speaks (moved from `opencode-config-codec.ts` `AISDK_PACKAGE`, format half) |
| `ChosenFormat` | `{ format: WireFormat; aiSdkPackage?: string }`: the chosen format, and the reference package when rule O2 chose it |
| `chooseFormat(model: DetailedModel): ChosenFormat \| undefined` | rule O2, unchanged in behaviour |
| `PROVIDER_DISPLAY_NAMES` | provider id → display name (moved from `opencode-config-codec.ts` `PROVIDER_NAMES`) |

Tests: `packages/core/tests/unit/client-connection.test.ts`.

### 2.2 Ports — `packages/core/src/ports/inbound/`

| File | Name | Responsibility |
|---|---|---|
| `client-origin.ts` | `ClientOrigin` | `{ origin: string; tokenCommand: readonly string[] }` (renamed from `OpencodeOrigin`; every user updated) |
| `pi.ts` | `PiConfigPort` (abstract) | `config(catalogs: readonly DetailedCatalog[], at: ClientOrigin): JsonObject`; `manifest(at: ClientOrigin): JsonObject` |

## 3. `packages/dialect-pi` (serves uc-pi-1 … uc-pi-3, P1–P7)

| File | Name | Responsibility |
|---|---|---|
| `src/adapters/inbound/pi-config-codec.ts` | `PiConfigCodec extends PiConfigPort` | P1–P3, P5–P7: providers, models, cost, compat, document, manifest |
| same | `piProviderId(provider)` | `ap-<provider>` |
| same | `PI_API` | `WireFormat` → `{ api, path }` (P2) |
| same | `PI_CONFIG_PATH` | `"/pi/models.json"` (single definition; the route handler imports it) |
| `src/adapters/inbound/pi-thinking.ts` | `piThinking(model, api)` | P4 and the thinking half of P5: `reasoning`, `thinkingLevelMap`, `compat.forceAdaptiveThinking` |

Tests: `tests/unit/pi-config-codec.test.ts` (output validated against `docs/reference/specs/pi-models-schema.json`),
`tests/unit/pi-thinking.test.ts`, `tests/component/pi-catalog.test.ts` (every model of
`docs/reference/specs/models-opencode-reference.json` through the codec: every document passes the schema, every
model's `api` is one its formats allow), empty `tests/live/.gitkeep`, `tests/e2e/.gitkeep`.

## 4. `apps/proxy`

| File | Change |
|---|---|
| `src/adapters/inbound/http/route-handler.ts` | `PI_WELL_KNOWN_PATH = "/.well-known/pi"` (open, like `/.well-known/opencode`); `PI_CONFIG_PATH` in the token-protected `own` set; `RoutePorts.pi: PiConfigPort`; `origin: ClientOrigin` |
| `src/adapters/inbound/cli/commands/catalog-commands.ts` | `PI_CONFIG_HELP`, `PiConfigCommand` (mirrors `OpencodeConfigCommand`) |
| `src/adapters/inbound/cli/commands/proxy-commands.ts` | `CliPorts.pi`; program help lists `PI_CONFIG_HELP` |
| `src/composition/container.ts` | `new PiConfigCodec()`; passed to `RouteHandler`, `Routes.ports`, `PiConfigCommand` |

Tests: unit `daemon.test.ts`, `cli-commands.test.ts`, `docs-in-step.test.ts` (lists); component
`tests/component/pi-config.test.ts` (feature suite `pi-config`: uc-pi-1 … uc-pi-3 positive and negative); e2e
`tests/e2e/pi-config.test.ts` (CLI and daemon, schema-validated), `tests/e2e/pi-routing.test.ts` (uc-pi-5 hermetic:
requests built with `fetch` exactly as pi 1.5.2 builds them from the served document — URL, auth header, body shape —
reach each format route of a signed-in daemon with replay upstreams), `docs.test.ts` probes, `cli.test.ts` help list.

## 5. `apps/pi-extension` (serves uc-pi-4, uc-pi-6)

Runs inside pi's Node.js process: only `node:*` modules and the global `fetch`; no `Bun` global and no `bun:` import
(enforced by `tests/arch/pi-extension-runtime.test.ts`). No runtime dependency: pi's extension API is described by a
structural type quoting pi 1.5.2 `dist/core/extensions/types.d.ts:1459-1547`, proven against the real binary in the live tier.

| Layer | File | Name | Responsibility |
|---|---|---|---|
| ports/outbound | `src/ports/outbound/proxy-discovery.ts` | `ProxyDiscoveryPort`, `PiManifest` | `manifest(): Promise<PiManifest>`; `config(url, token): Promise<JsonObject>` |
| ports/outbound | `src/ports/outbound/token-source.ts` | `TokenSourcePort` | `token(command: readonly string[]): Promise<string>` |
| ports/outbound | `src/ports/outbound/pi-host.ts` | `PiHostPort`, `PiProviderConfig`, `PiModelConfig` | `registerProvider(id, config)`; `warn(message)`; `readEnv(name)`; `setEnv(name, value)` |
| application | `src/application/register-providers.ts` | `RegisterProvidersService` | `run(): Promise<void>`: manifest → token (only when `ACCOUNTS_PROXY_TOKEN` is unset) → config → `piDefaults` → one `registerProvider` per provider with `refreshModels` (re-reads manifest and config, returns that provider's models, rejects on failure); `run` never throws and warns once on failure |
| application | same | `piDefaults(model)` | pi's documented `models.json` defaults for fields an extension must state (`input ["text"]`, `contextWindow 128000`, `maxTokens 16384`, `reasoning false`, `cost` zeros: pi `docs/models-configuration.md:36-53`, `dist/core/provider-composer.js:107`) |
| adapters/outbound | `src/adapters/outbound/http-proxy-discovery.ts` | `HttpProxyDiscovery` | the `fetch` function given to its constructor (the global one in composition), 5000 ms deadline (`AbortSignal.timeout`), base `ACCOUNTS_PROXY_URL` or `http://127.0.0.1:4141` |
| adapters/outbound | `src/adapters/outbound/exec-token-source.ts` | `ExecTokenSource` | the `execFile` function given to its constructor (`node:child_process` `execFile` in composition; no shell), 10000 ms, trimmed stdout, non-empty |
| adapters/outbound | `src/adapters/outbound/extension-pi-host.ts` | `ExtensionPiHost` | adapts pi's `ExtensionAPI` (`registerProvider`), stderr warnings, `process.env` |
| composition | `src/composition/extension-container.ts` | `buildExtension(api, env)` | wires the graph |
| main | `src/main/extension.ts` | default export | `async (pi) => buildExtension(pi, process.env).run()` |

`package.json`: `"pi": { "extensions": ["./src/main/extension.ts"] }`, no `dependencies`; `devDependencies`
`@accounts-proxy/test-support` and `@accounts-proxy/dialect-pi` (the component suite serves a document the real codec
produces).

Tests: unit per class (no I/O); component `tests/component/register-providers.test.ts` (feature suite `pi-extension`:
uc-pi-4, uc-pi-6 with fakes, plus the real default export against a closed loopback port); e2e `tests/e2e/extension.test.ts` (the real `main` factory in a child process under the e2e
coverage preload, against a real daemon); live `tests/live/pi-binary.test.ts` (dependency `pi`: load, list,
negatives) and `tests/live/pi-<provider>.test.ts` for each of the seven providers (uc-pi-5 cells).

## 6. Tooling

| File | Change |
|---|---|
| `scripts/evidence/fetch-specs.ts` | `{ file: "pi-models-schema.json", url: "https://pi.dev/schemas/models.schema.json" }` |
| `tests/support/json-schema.ts` | keywords `$comment`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `minLength`, `maxItems`, `patternProperties` |
| `scripts/gate/granularity-report.ts` | reads the use-case ids of the product designs listed in `GRANULARITY_DESIGNS` (initially this feature only) and the `[feature=… use-case=… tier=… polarity=…]` tags in test names; fails on any missing component, live, e2e or negative scenario |
| `scripts/gate/verify.ts` | adds `granularity report` after the docs lint |
| `tests/arch/architecture.test.ts` | workspace list adds `@accounts-proxy/dialect-pi`, `@accounts-proxy/pi-extension` |

## 7. `packages/provider-antigravity` (serves uc-pi-7)

| File | Name | Responsibility |
|---|---|---|
| `src/domain/native-gemini.ts` | `idCalls` (private) | synthesizes and pairs tool-call ids on a non-Gemini target (uc-pi-7) |

Tests: `packages/provider-antigravity/tests/{unit,component}`, `apps/proxy/tests/e2e/gemini-cell.test.ts`.
