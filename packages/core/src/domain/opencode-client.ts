// OpenCode's own request headers, shared by every provider whose reference client is OpenCode (the OpenCode Console
// cells and the ChatGPT plan-usage cell). The proxy forwards them as the client sends them and never invents them.

/** Z15: the conversation id OpenCode sends. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * Z26, recon gaps O2 and P2: OpenCode's own request headers — its User-Agent (the Console's free models answer only
 * OpenCode's own), its trace context and its session, project and client ids (opencode v2.1.1
 * `packages/core/src/session/model-request.ts:281-292`; captured on every inference request, recon runs
 * opencode/2026-10-23-03-50-16 and, toward OpenAI, opencode/2026-10-24-07-08-58).
 */
export const OPENCODE_CLIENT_HEADERS: readonly string[] = [
  "user-agent",
  "b3",
  "traceparent",
  "x-opencode-client",
  "x-opencode-project",
  OPENCODE_SESSION_HEADER,
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
];
