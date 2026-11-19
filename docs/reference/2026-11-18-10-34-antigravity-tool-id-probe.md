# Antigravity tool-call ids: the 400 and the law

Probe of 2026-11-18, plan step 8A.1 of
[the pi compatibility plan](../plans/2026-11-15-23-52-pi-compatibility-plan.md) (amendment 5, § 2 and § 7). Cell:
`antigravity` × `google-generative-ai` (pi 1.5.2's Gemini API client).

## 1. The failing request and its 400

Models `antigravity/claude-opus-5-5-high` and `antigravity/claude-opus-5-5-low`; every tool turn; output caps 128 and
256 answer identically. The upstream body:

```json
{"error":{"code":400,"message":"{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.1.content.0.tool_use.id: Field required\"},\"request_id\":\"req_vrtx_...\"}","status":"INVALID_ARGUMENT"}}
```

- Recorded with this body in `docs/sessions/ses_e1d2bb206ffeA1ncekZZy0G4WO.md:252` (step 8.3 E1 findings, item 4)
  and in [the issue note](../issues/2026-11-16-20-47-antigravity-tool-use-id-gap.md). The request id is redacted in
  the record to its prefix `req_vrtx_...`; no full id is reproduced here.
- `messages.1` is the second Anthropic Messages turn that Claude-on-Vertex builds from the Gemini `contents`: the turn
  that carries the tool call and its result. The first turn (`messages.0`, the user question) is accepted, so the
  refusal is about the `tool_use` block alone.

## 2. Why pi sends no id

pi 1.5.2 at `/opt/homebrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`,
file `node_modules/@earendil-works/pi-ai/dist/api/google-shared.js`:

- `google-shared.js:125-130` — the predicate:
  ```js
  export function requiresToolCallId(modelId) {
      const geminiMajorVersion = getGeminiMajorVersion(modelId);
      return (modelId.startsWith("claude-") ||
          modelId.startsWith("gpt-oss-") ||
          (geminiMajorVersion !== undefined && geminiMajorVersion >= 3));
  }
  ```
- `google-shared.js:235` — the call part: `...(requiresToolCallId(model.id) ? { id: block.id } : {}),`
- `google-shared.js:270-276` — the response part: `const includeId = requiresToolCallId(model.id);` and
  `...(includeId ? { id: msg.toolCallId } : {}),`
- pi passes `model.id` as the pi model id (`antigravity/claude-opus-5-5-high`, the id its served `models.json` gives
  it), which starts with none of those prefixes: neither `claude-` nor `gpt-oss-`, and
  `getGeminiMajorVersion` (`google-shared.js:131-136`, `/^gemini(?:-live)?-(\d+)/`) does not match a provider-prefixed
  id at all.

Probe (`node --input-type=module`, importing that file, 2026-11-18):

```
antigravity/claude-opus-5-5-high -> false
claude-opus-5-5-high -> true
antigravity/gemini-3.6-flash-low -> false
gemini-3.6-flash-low -> true
```

So the omission is pi's design for a provider-prefixed model id, not a bug in the request body pi sends.

## 3. The real antigravity client does send ids

`tests/fixtures/captures/p0-live/e3/t4-f3a-tool-choice-auto.json` (model `gpt-oss-120b-medium`) records the upstream
answer

```json
"functionCall": {"name": "get_time","args": {"timezone": "Asia/Tokyo"},"id": "call_7f6c7a16ca5f4035a8d18358"}
```

The id is an opaque `call_<32 hex>` string, so the law does not copy its shape. The proxy already reads that optional
id where it signs calls (`packages/provider-antigravity/src/domain/native-gemini.ts:170-172`) and returns the contents
unchanged for a non-Gemini target (`native-gemini.ts:163-164`).

## 4. Inferred: the mapping Claude-on-Vertex performs

Claude-on-Vertex maps a Gemini `functionCall` part onto Anthropic `tool_use`, which requires `id`, and a
`functionResponse` part onto `tool_result`, which requires the matching `tool_use_id`. The failed request carried
`messages.1`, exactly the turn where a call and its response travel. The conversion must therefore synthesize an id
per call and re-use it on the matching response. Nothing in this section is measured; it is inferred from § 1 and § 3.

## 5. Not known

- Whether the upstream also requires `functionResponse.id` to equal the call's `id`. Closed by plan step 8A.7 (the
  live tool turn) and step 8.3r: the turn either goes green, or answers a new 400 whose body is recorded.
- Whether an id-less call on a *Gemini* target must also get an id. Not needed: the Gemini tool turns pass today
  (`docs/sessions/ses_e1d2bb206ffeA1ncekZZy0G4WO.md` § Live), so the law stays restricted to non-Gemini targets and
  the Gemini cells regress zero.

## 6. The law

`AGENTS.md` §3, one row:

> Antigravity Gemini cell: on a non-Gemini target every `functionCall` without an `id` gets `ap_call_<n>`
> (request-scoped, deterministic, never colliding with an id the request carries) and its `functionResponse` the same
> id, because Claude-on-Vertex requires `tool_use.id` and pi 1.5.2 omits ids for provider-prefixed model ids.

The law lives in `idCalls` (`packages/provider-antigravity/src/domain/native-gemini.ts`), called from
`prepareGeminiRequest` directly after `signCalls`.
