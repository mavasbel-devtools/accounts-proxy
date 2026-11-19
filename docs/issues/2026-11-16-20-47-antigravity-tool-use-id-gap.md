# Antigravity tool-turn gap: Gemini `functionCall` without id against Claude-on-Vertex

Date: 2026-11-16. Session: `ses_e1d2bb206ffeA1ncekZZy0G4WO`.
Step: 8.1r live tier, `apps/pi-extension/tests/live/pi-antigravity.test.ts` tool turn.
Status: filed for the plan agent; fix is out of the pi-compatibility plan's scope (no proxy translator change planned).

## Symptom

Every tool turn routed `antigravity x google-generative-ai` (pi's Gemini API client) fails
deterministically at the upstream with HTTP 400:

```json
{"error":{"code":400,"message":"{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.1.content.0.tool_use.id: Field required\"},\"request_id\":\"req_vrtx_...\"}","status":"INVALID_ARGUMENT"}
```

## Reproduction (no test harness needed)

```sh
D=$(mktemp -d /tmp/pi-read-XXXX)
printf '{"providers":{"ap-antigravity":{"modelOverrides":{"antigravity/claude-opus-5-5-high":{"maxTokens":256}}}}}' > $D/models.json
echo PINEAPPLE > $D/pineapple.txt
env -u ACCOUNTS_PROXY_TOKEN ACCOUNTS_PROXY_URL=http://127.0.0.1:4142 PI_CODING_AGENT_DIR=$D \
  /opt/homebrew/bin/pi -e ./apps/pi-extension/src/main/extension.ts \
  --system-prompt "Answer in one word." --tools read \
  --no-context-files --no-skills --no-prompt-templates --no-mcp --no-extensions --no-session \
  -p --model "ap-antigravity/antigravity/claude-opus-5-5-high" \
  "Use the read tool on $D/pineapple.txt and reply with its single word"
# exit=1, 400 tool_use.id: Field required
```

## Evidence (2026-11-16, disposable daemon on 127.0.0.1:4142)

- `antigravity/claude-opus-5-5-high` tool turn at cap 64: pi reports output-token truncation, exit 1.
- Same turn at cap 128 and at cap 256: `tool_use.id: Field required`, exit 1.
- `antigravity/claude-opus-5-5-low` tool turn at cap 128: identical `tool_use.id` 400.
- So: not the cap (proven 64/128/256) and not the model (proven on two models). Systematic to the route.

## Suspected root cause (unverified, for the plan agent to confirm)

pi's `@google/genai` client sends Gemini-native `functionCall` parts, which carry no id.
The upstream for these models is Claude-on-Vertex, which speaks the Anthropic wire format
and requires `tool_use.id`. Somewhere on the gemini-inbound → Claude-on-Vertex path the
conversion must synthesize an id per call, and it does not:

- `packages/provider-antigravity/src/domain/native-gemini.ts:170-172` reads an optional
  `call["id"]` from `functionCall` (some other client sends one; pi never does).
- `packages/provider-antigravity/src/domain/signCalls` (`native-gemini.ts:163-191`) only
  handles Gemini-family models; Claude models pass through untouched.
- No `tool_use` construction exists anywhere under `packages/provider-antigravity/src/`.

## Impact on the pi-compatibility plan

Step 8.1r records the antigravity tool turn as blocked-on-proxy with the evidence above.
All other antigravity live tests (plain/thinking via `opencode/gemini-3.5-flash-lite`,
negatives) are unaffected. The user approved filing this for a follow-up plan
that may touch the proxy translator.
