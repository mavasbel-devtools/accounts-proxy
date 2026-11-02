# Implementation Plan: Antigravity Generative Model Tool Calling Capabilities & Reference Resolution

## 1. Executive Summary & Problem Diagnosis
Under OpenCode v2.1.4, sessions interacting with Antigravity models (specifically `gemini-3.8-flash-medium`) consistently fail with `interrupted` after ~60 seconds following a tool execution step.
Root cause analysis across `opencode.jsonc`, `packages/provider-antigravity/src/domain/catalog.ts`, and `packages/core/src/domain/model-details.ts` established:
1. Google Cloud Code Assist upstream API descriptors (`fetchAvailableModels`) do not explicitly emit `tool_call: true`.
2. Core reference catalog lookup (`describeModel` in `model-details.ts`) matches model IDs via strict exact string equality against reference provider catalog entries (`models.opencode.ai:google/<modelId>`). For tiered/suffixed variants like `gemini-3.8-flash-medium` against reference model `google/gemini-3.8-flash`, exact matching fails.
3. Because both the provider descriptor and the reference fallback fail to declare `toolCall: true`, `OpencodeConfigCodec.modelConfig()` omits `capabilities.tools` from `http://127.0.0.1:4141/opencode/config.json`.
4. OpenCode v2.1.4 requires `capabilities.tools: true` for models executing tool turns; without it, the runner's internal scheduler fails to dispatch subsequent assistant turns, timing out after 60 seconds into `interrupted`.

This plan specifies the complete, 100% test-covered, zero-skip implementation to:
- Explicitly declare tool capability support (`toolCall: true`) for generative Gemini and Claude models in `packages/provider-antigravity/src/domain/catalog.ts`.
- Implement normalized suffix variant fallback resolution in `packages/core/src/domain/model-details.ts`.
- Update all associated unit, component, and e2e tests, verifying 100% gate pass.

---

## 2. Evidence Trail & Authoritative Grounding
- Upstream Capture: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/tests/fixtures/captures/recon-parity/antigravity-1.107.0/captures/3124-response.json` confirms available Antigravity models: `gemini-3.8-flash-medium`, `gemini-3.5-flash-low`, `gemini-2.5-pro`, `gemini-3.1-flash-lite`, `gemini-3-flash`, `claude-opus-5-5-medium`, etc.
- Reference Catalog: `/home/mavasbel/.cache/opencode/models.json` contains Google models without suffix tiers (`gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.1-flash-lite`), all declaring `"tool_call": true`.
- OpenCode Config Codec: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/dialect-opencode/src/adapters/inbound/opencode-config-codec.ts:88-92`:
  ```ts
  const capabilities: JsonObject = {
    ...(model.toolCall !== undefined ? { tools: model.toolCall } : {}),
    ...(model.input !== undefined ? { input: [...model.input] } : {}),
    ...(model.output !== undefined ? { output: [...model.output] } : {}),
  };
  ```

---

## 3. Architecture & Hexagonal Boundaries
- **Layering Law**:
  - `packages/provider-antigravity/src/domain/catalog.ts` belongs to the pure domain layer of `provider-antigravity`.
  - `packages/core/src/domain/model-details.ts` belongs to the pure domain layer of `core`.
  - No external dependencies, relative imports, or layer boundary breaches are introduced.
  - IoC and existing abstractions are strictly preserved.

---

## 4. Phase-by-Phase Execution Plan

### Phase 1: Antigravity Domain Catalog Tool Capabilities
**File**: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/provider-antigravity/src/domain/catalog.ts`
- **Objective**: In `descriptorDetails(m: ModelDescriptor): ModelDetails`, generative models (Gemini and Claude models that support text/chat generation) must declare `toolCall: true`.
- Models excluded: Tab completion models (`tab_jump_*`, `tab_*`, `chat_20706`, `chat_23310`) and pure image generation models (`gemini-3.1-flash-image` which has `imageGenerationModelIds` in capture and does not support chat tool calling).
- Logic:
  ```ts
  const isImageModel = m.wireId.endsWith("-image");
  const isTab = m.wireId.startsWith("tab_") || m.wireId.startsWith("chat_");
  const toolCall = !isImageModel && !isTab;
  ```
- Return `{ input, reasoning: m.supportsThinking, toolCall }`.

### Phase 2: Core Model Details Normalized Reference Resolution
**File**: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/core/src/domain/model-details.ts`
- **Objective**: When looking up `reference` in `describeCatalog`:
  If an exact match for `model.address.model` is not found in `entries`, try looking up by normalized model ID by stripping tier suffixes (`-low`, `-medium`, `-high`, `-tiered`, `-extra-low`).
- Logic:
  ```ts
  function resolveReferenceModel(entries: ReadonlyMap<string, ReferenceModel> | undefined, modelId: string): ReferenceModel | undefined {
    if (entries === undefined) return undefined;
    const direct = entries.get(modelId);
    if (direct !== undefined) return direct;
    const normalized = modelId.replace(/-(extra-low|low|medium|high|tiered)$/, "");
    if (normalized !== modelId) {
      return entries.get(normalized);
    }
    return undefined;
  }
  ```
- Use `resolveReferenceModel(entries, m.address.model)` in `describeCatalog`.
- In `describeModel`, ensure that the reference source string `ref` uses the resolved model key or remains truthful to the reference catalog provider.

### Phase 3: Unit & Component Tests Update
1. **Antigravity Unit Tests**:
   - `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/provider-antigravity/tests/unit/domain.test.ts`
   - Add test cases verifying `descriptorDetails` sets `toolCall: true` for generative Gemini and Claude models and `toolCall: false` for image/tab models.
2. **Core Unit Tests**:
   - `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/core/tests/unit/model-details.test.ts`
   - Add test cases verifying `describeCatalog` normalizes tier suffixes (`-medium`, `-low`, `-high`, etc.) to match reference catalog entries.
3. **Dialect OpenCode Unit Tests**:
   - `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/dialect-opencode/tests/unit/opencode-config-codec.test.ts`
   - Verify `capabilities.tools: true` is populated in the generated config for Antigravity models.

### Phase 4: Full Coverage & Verification Gate
- Run `bun scripts/gate/run-tests.ts coverage` to confirm 100% lines, statements, functions, branches.
- Run `bun run verify` to execute typecheck, unit/component/arch gate, build, e2e gate, and docs lint.

---

## 5. Verification Checklist & Acceptance Criteria
- [ ] `packages/provider-antigravity/src/domain/catalog.ts` returns `toolCall: true` for `gemini-3.8-flash-medium`.
- [ ] `packages/core/src/domain/model-details.ts` resolves reference details for suffix-variant model IDs.
- [ ] `http://127.0.0.1:4141/opencode/config.json` outputs `capabilities.tools: true` for `gemini-3.8-flash-medium`.
- [ ] All unit, component, and e2e tests pass with 100% coverage.
- [ ] No regressions in existing log-files, console-mirror, or gateway tests.
