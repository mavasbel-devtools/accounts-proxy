# Forensic Analysis: OpenAI Router Stopping / Disconnection Investigation

**Session ID**: `ses_ef10d7fa0ffe2baUvsApfbHHPZ`
**Timestamp**: 2026-11-02-05-05 (UTC)
**Repository**: `/home/mavasbel/Dev/repos/devtools/accounts-proxy`
**Subject**: Exhaustive Investigation of OpenAI (`ap-openai`) Router Integration vs Gemini Stalls

---

## 1. Executive Summary & Core Verdict

The user asked:
> *"Can we review if openai integration of the router has any similar problem to gemini?! It is also stopping too often!"*

### Direct Verdict
1. **Does OpenAI have the Gemini tool capability defect?**
   **NO.** Gemini suffered from an ID mismatch (`gemini-3.8-flash-medium` vs canonical catalog `google/gemini-3.8-flash`), causing `capabilities.tools` to be omitted (`undefined`) in `GET /opencode/config.json`, which triggered OpenCode's 60-second watchdog stall and `interrupted` abort after tool turns.
   In contrast, for `ap-openai`, `gpt-5.6-terra` advertises:
   - `capabilities.tools: true`
   - `package: "@opencode/ai/providers/openai"`
   - `settings.baseURL: "http://127.0.0.1:4141/openai/v1"`
   - Full variants for `reasoningEffort` (`none`, `low`, `medium`, `high`, `xhigh`, `max`).

2. **Why does it appear to "stop too often" or stall?**
   Forensic analysis of proxy logs (`.cache/logs/2026-11-02-674769-usage.jsonl` and `2026-11-02-3160812-usage.22.jsonl`), proxy stdout logs, and OpenCode system logs (`~/.local/share/opencode/log/opencode.log`) identified **three distinct root mechanisms**:
   - **Mechanism 1 (Upstream Socket Cancellation on Client Abort)**: In multiple exchanges, while OpenAI was streaming `response.output_item.done`, the client closed the HTTP connection before reading to completion. This caused Node/Bun fetch in the proxy to throw `AbortError: The operation was aborted` on the upstream body reader, logged as `stream closed by the client model=gpt-5.6-terra terminal=response.completed`.
   - **Mechanism 2 (High Reasoning Latency & TTFT)**: Under `reasoningEffort: "high"` (the default variant in sessions like `ses_e7b7af8fbffe1KxiXfMYP3dDiF`), upstream `chatgpt` reasoning generation produces 25,000–130,000 reasoning tokens per session. Certain tool turns take up to **30.38 seconds** (`c-ade79ce7`, `c-6d3f690f`) of pure reasoning before emitting the first content token or tool call. If the user sends a new prompt or interacts during this thinking window, OpenCode aborts the in-flight run.
   - **Mechanism 3 (OpenCode UI SSE Disconnects)**: OpenCode's CLI log recorded repeated events: `component=client attempt=1 error="Event stream stalled"` followed by `attempt=2 error="Timed out connecting to server"`. This occurs when the shared OpenCode daemon's event emitter stalls under high host load, decoupling the TUI from the server while the proxy and upstream LLM are actually executing normally.

3. **Session Outcome Statistics in OpenCode**:
   Audit of all 9 `ap-openai` sessions in OpenCode revealed:
   - **100% (9 out of 9) have outcome: `"succeeded"`** (0 marked `interrupted`, 0 marked `failed`).
   - By comparison, Antigravity Gemini had 3 sessions marked `interrupted` (`ses_e66cde90fffe5guPrCjNCElDvh`, `ses_e66d8f6ddffeAh3fLYBbLnep5J`, `ses_e66dcdb98ffepOBd1zGuW67Oji`) precisely before the catalog capability fix.

---

## 2. Comparative Matrix: Gemini vs OpenAI

| Diagnostic Dimension | Antigravity (Gemini) | OpenAI (`ap-openai` / ChatGPT) |
| :--- | :--- | :--- |
| **Upstream Protocol** | Google Cloud Code Assist (`v1internal:generateContent`) | OpenAI Responses (`POST /v1/responses`, ChatGPT Plan) |
| **Catalog Mapping** | `gemini-3.8-flash-medium` -> variant stripped to `google/gemini-3.8-flash` | `gpt-5.6-terra` mapped to `@opencode/ai/providers/openai` |
| **`capabilities.tools`** | Was `undefined` (fixed to `true` via `isGenerativeGemini`) | **Always `true`** |
| **Tool Execution Replay** | `functionResponse` in model contents + `thoughtSignature` | `function_call_output` in `input` array |
| **Stream Terminal Event** | Trajectory end / `candidates[0].finishReason` | `event: response.completed` / `response.incomplete` |
| **Output Repair** | N/A | `StreamRepair` injects `output` into terminal frame (Rule I6) |
| **Observed Abort Pattern** | Hard 60-second watchdog stall inside OpenCode runner | Client-initiated connection drops or UI stream stalls |

---

## 3. Evidence Artifacts & Inspection Trails

1. **Proxy Config Endpoint**:
   `GET http://127.0.0.1:4141/opencode/config.json`
   Contains valid tool configuration and variants:
   ```json
   "ap-openai": {
     "modelID": "openai/gpt-5.6-terra",
     "capabilities": {
       "tools": true,
       "input": ["text", "image", "pdf"],
       "output": ["text"]
     },
     "limit": {
       "context": 1050000,
       "input": 922000,
       "output": 128000
     }
   }
   ```

2. **Proxy Usage Log**:
   - `/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/logs/2026-11-02-674769-usage.jsonl`
   - All 29 OpenAI requests in the active log received HTTP 200 and completed upstream frames (`response.completed`).
   - Sample exchange `c-88ffeef9-6818-4b75-9b3e-b65cbde43100`:
     Output items correctly repaired with `[ "reasoning", "function_call:skill" ]`.

3. **OpenCode Session Record**:
   - Session `ses_e7b7af8fbffe1KxiXfMYP3dDiF` (Title: *"Jobs applications framwork"*):
     - Tokens: 4,206,489 input, 579,601 output, 58,058 reasoning, 100,577,738 cache read.
     - Outcome: `succeeded`.
     - 50 consecutive tool/assistant turns completed without unhandled exceptions.

---

## 4. Remediation & Operational Guidance

1. **When OpenAI feels "stopped"**:
   Check if the model is in extended reasoning (`reasoningEffort: "high"`). Responses models do not emit text deltas while generating reasoning tokens unless `reasoning.summary` is rendered.
2. **If OpenCode TUI disconnects**:
   Run:
   ```bash
   opencode service status && opencode api get /api/info
   ```
   Do not restart the proxy; the proxy daemon maintains active socket state.
