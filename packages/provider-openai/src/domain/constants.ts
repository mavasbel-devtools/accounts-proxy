// OpenAI "Sign in with ChatGPT" plan usage: wire constants. Each value cites its source; the rules document is
// docs/reference/2026-10-11-23-08-openai-chatgpt-plan-rules.md (S*, T*, M*, I*, E* rule ids below), the specs are under
// docs/reference/specs/openai-siwc-*.md, and chatgpt.ts is opencode @ 35ef229454 (vendored in
// tests/reference/plugin-35ef229454/plugin/provider/chatgpt.ts).

/** S1 (chatgpt.ts:22). */
export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_PATH = "/api/accounts/authorize";
/** S10 (chatgpt.ts:23). */
export const TOKEN_PATH = "/api/accounts/oauth/token";
/** S12 (chatgpt.ts:458). */
export const JWKS_PATH = "/.well-known/jwks.json";
/** S6, I1 (chatgpt.ts:24). */
export const RESOURCE = "https://api.openai.com/v1";
export const API_BASE = "https://api.openai.com";
/** S2 (chatgpt.ts:20): the first-registration entry point; never saved as a client id. */
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
/** S3, decision O4: the app's actual name. */
export const AGENT_NAME = "inference-router";
/** S11 (chatgpt.ts:25). */
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
/** S6 (chatgpt.ts:532). */
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`;
/** S5: only the port varies. */
export const CALLBACK_PATH = "/auth/callback";
/** T5 (chatgpt.ts:495). */
export const DEFAULT_EXPIRES_IN_S = 3600;
/** Renew this long before expiry: the router's common 2-minute buffer (Claude and Antigravity use the same value). */
export const EXPIRY_BUFFER_MS = 120_000;
/** The router's own User-Agent on OpenAI calls (opencode sends its own app's, chatgpt.ts:367,410). */
export const USER_AGENT = "inference-router/0.1.0";

/** M2 (chatgpt.ts:30-47): the built-in model list, used when the live list is unavailable. */
export const FALLBACK_MODELS: readonly string[] = [
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6-luna",
  "gpt-6-luna-fast",
  "gpt-6-sol",
  "gpt-6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
];

/** Model catalog: live list cached for 24 h (the Claude catalog's rule), one cache per account registration. */
export const CATALOG = { ttlMs: 24 * 60 * 60 * 1000, timeoutMs: 15_000 } as const;

/** I3 (openai-siwc-preview-limitations.md "Responses API requirements"). */
export const UNSUPPORTED_FIELDS: readonly string[] = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/**
 * I4 (preview-limitations "Supported tools"): hosted tool types this route rejects, as named by the Responses API
 * (openai-openapi.yaml tool `type` enums): image generation, file search, Code Interpreter, computer use, hosted
 * MCP/connectors, tool_search, and programmatic_tool_calling in top-level tools.
 */
export const UNSUPPORTED_TOOL_TYPES: readonly string[] = [
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use_preview",
  "mcp",
  "tool_search",
  "programmatic_tool_calling",
];

/** E2 (openai-siwc-errors-and-recovery.md "Structured Responses errors"): the HTTP status of each code. */
export const SHARING_ERROR_STATUS: Readonly<Record<string, number>> = {
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
  subscription_sharing_user_unavailable: 503,
};
