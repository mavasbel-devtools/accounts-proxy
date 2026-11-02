# Plan: Console Logging Demotion & Antigravity Capability Audit

**Plan Date**: 2026-11-02-05-30
**Repository**: `/home/mavasbel/Dev/repos/devtools/accounts-proxy`
**Goal**:
1. Stop dumping full client/upstream HTTP request bodies to stdout in terminal while preserving forensic audit logging to `.cache/logs/*-usage.*.jsonl`.
2. Confirm 100% certainty and evidence across all 21 Antigravity models for tool support.
3. Address client disconnects and high-TTFT reasoning behavior for OpenAI.

---

## 1. Inventory & Root Cause Analysis

### Issue A: Console Logging the FULL Request
- **Location**: `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/composition/container.ts:438`
  ```typescript
  const exchangeLog = usageLog !== undefined ? {
    sink: new StreamExchangeSink(usageLog, clock, new NodeHash(), process.pid, mirror),
    scope: new AsyncExchangeScope()
  } : undefined;
  ```
- **Cause**: In Phase 2026-11-01, `mirror` (an instance of `TerminalMirror` connected to `stdout`) was passed to `StreamExchangeSink`. Whenever `LoggingTransport` intercepts a request or response, `sink.write(entry)` formats the entire JSONL record (including client request bodies, headers, and responses) and executes `this.mirror?.line(line);`.
- **Intended Behavior**: As established in `#5365`, the daemon must default to a **Clean Console** standard, showing only operational status logs and errors via `MirroredLogger` (`proxy.log`), while comprehensive multi-kilobyte forensic records remain strictly inside the dedicated usage log file streams (`.cache/logs/*-usage.*.jsonl`).
- **Remediation**:
  In `container.ts`, instantiate `StreamExchangeSink` without `mirror` (or pass `undefined`), so exchange telemetry flows exclusively to `usageLog`.

### Issue B: Antigravity Models Capabilities Audit
- **Location**: `packages/provider-antigravity/src/domain/catalog.ts` & `packages/core/src/domain/model-details.ts`
- **Audit Findings**:
  All 21 Antigravity models in the active catalog were queried from `GET /opencode/config.json`.
  - 18 models (all generative Gemini, Claude, and GPT-OSS models) advertise `capabilities.tools: true`.
  - Exactly 3 non-generative / specialized models advertise `tools: false`:
    1. `gemini-3.1-flash-image` (Image generation model)
    2. `tab_flash_lite_preview` (Autocomplete / tab completion model)
    3. `tab_jump_flash_lite_preview` (Autocomplete jump model)
  Every model capable of tool calling has `tools: true`.

### Issue C: OpenAI Disconnects & High TTFT
- **Analysis**:
  - `gpt-5.6-terra` under `reasoningEffort: "high"` produces up to 30.38 seconds of initial reasoning time.
  - The client connection is severed when either the UI SSE stalls or the user initiates another prompt during this TTFT window.
  - No code defect exists in the OpenAI adapter; handling requires operational awareness of reasoning effort profiles and daemon responsiveness.

---

## 2. Execution Phases

### Phase 1: Outbound Sink Refactoring & Container Wiring
1. Update `apps/proxy/src/composition/container.ts`:
   Remove `mirror` from `new StreamExchangeSink(...)` call so `StreamExchangeSink` writes only to `usageLog`.
2. Update unit & component tests in `apps/proxy/tests/component/exchange-log-file.test.ts` to verify `StreamExchangeSink` does not mirror to console unless explicitly provided, and test behavior when `mirror` is omitted.
3. Update `apps/proxy/tests/unit/docs-in-step.test.ts` or architecture tests if applicable.

### Phase 2: Verification Gate & Audit
1. Run `bun run verify` (typecheck, 100% unit+component coverage, build, e2e gate).
2. Measure 100% statements, branches, functions, and lines.

### Phase 3: Live Daemon Verification
1. Restart the terminal proxy daemon.
2. Send test inference requests through `curl` or OpenCode.
3. Verify that stdout in the terminal prints only standard operational logs (Clean Console) and zero raw JSONL exchange records.
4. Verify `.cache/logs/*-usage.*.jsonl` still captures all 4 exchange stages.
