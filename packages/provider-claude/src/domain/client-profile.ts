// Profile of the official Claude Code CLI (2.1.304, sha256 ad2816b085...):
// Derived from recon MITM capture claude/2026-10-22-02-04-42-workflow (seq 18) and decompiled official bundle.

export const CLAUDE_PROFILE = {
  version: "2.1.304",
  entrypoint: "sdk-cli",
  cch: "a3181",
  sdkPackageVersion: "0.128.0",
  anthropicVersion: "2023-06-01",
  identityText: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  dispatchId: "v2d",
  atis: "711efd76d10f17e5",
  requestClass: "main",
  app: "cli",
  userAgent: "claude-cli/2.1.304 (external, sdk-cli)",
  os: "Linux",
  arch: "x64",
  fingerprintSalt: "59cf53e54c78",
  fingerprintIndices: [4, 7, 20] as const,
} as const;

export const BETA_OPUS_5_5 =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07,message-threads-2026-08-12";

/** Canonical HTTP header casing and order as sent by Claude Code 2.1.304. */
export const CLAUDE_MESSAGE_HEADER_NAMES: readonly string[] = [
  "Accept",
  "Authorization",
  "Content-Type",
  "User-Agent",
  "X-Claude-Code-Session-Id",
  "X-Stainless-Arch",
  "X-Stainless-Lang",
  "X-Stainless-OS",
  "X-Stainless-Package-Version",
  "X-Stainless-Retry-Count",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "X-Stainless-Timeout",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-dispatch-id",
  "anthropic-version",
  "x-app",
  "x-cc-atis",
  "x-claude-code-prompt-id",
  "x-claude-code-request-class",
  "x-client-request-id",
];

