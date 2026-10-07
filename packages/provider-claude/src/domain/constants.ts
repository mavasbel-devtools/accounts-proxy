// Claude subscription constants. Sources:
//  [B] official Claude Code 2.1.280 binary, sha256 0e4195524b73…5469 (docs/reference/…-p0-e6-browser-login-mechanisms.md)
//  [P] opencode-claude-auth @ 6292741, src/domain/services/RequestTransformService.ts (captured real-CLI wire)

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // [B] CLIENT_ID, [P] CLIENT_ID
export const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"; // [B] CLAUDE_AI_AUTHORIZE_URL (subscription login)
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"; // [B] TOKEN_URL
export const MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"; // [B] MANUAL_REDIRECT_URL
export const CLAUDEAI_SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code"; // [B]
export const CONSOLE_SUCCESS_URL = "https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code"; // [B]
export const LOOPBACK_CALLBACK_PATH = "/callback"; // [B] `http://localhost:${port}/callback`
export const INFERENCE_SCOPE = "user:inference"; // [B] Ov

/** [B] gqe(): the refresh scope list with PLUGINS_SCOPE_REGISTERED = true. */
export const REFRESH_SCOPES: readonly string[] = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

/**
 * [B] kCr() = U([org:create_api_key, user:profile, ...gqe()]). The duplicate user:profile is removed; the order
 * equals the captured authorize scope of [P] (fixture authorize-params.json) plus 2.1.280's user:plugins.
 */
export const AUTHORIZE_SCOPES: readonly string[] = ["org:create_api_key", ...REFRESH_SCOPES];

/** [P] TOKEN_HEADERS, captured from the real CLI's refresh (fixture refresh-request-headers.json). */
export const TOKEN_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "axios/1.15.2",
};

export const API_BASE = "https://api.anthropic.com"; // [P] API_BASE, [B] BASE_API_URL
export const CLAUDE_VERSION = "2.1.280.b1a"; // [P]
export const CLAUDE_ENTRYPOINT = "sdk-cli"; // [P]
export const CLAUDE_CCH = "ae63b"; // [P]
export const SDK_PACKAGE_VERSION = "0.112.1"; // [P]
export const ANTHROPIC_VERSION_HEADER = "2023-06-01"; // [P]
export const ANTHROPIC_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."; // [P]

/** [P] credentialExpired default buffer: refresh when fewer than 120 s remain. */
export const EXPIRY_BUFFER_MS = 120_000;

/** [P] AnthropicModelsApiAdapter / RefreshModelCatalogUseCase catalog contract (AGENTS.md §9). */
export const CATALOG = { pageSize: 100, maxPages: 10, timeoutMs: 3_000, ttlMs: 24 * 60 * 60 * 1000 } as const;
