// Antigravity constants. Source: opencode-antigravity-auth @ 5c6f7c2697fdc187bfc1d5f0208b8f5563620875
// (src/infrastructure/config/PluginConfig.ts — "ground-truth constants extracted from Antigravity IDE 2.5.5 (main.js)
// + captured consent URLs"; AntigravityApiClientAdapter.ts; LoopbackCallbackServerAdapter.ts; ModelCatalogService.ts).

import { ANTIGRAVITY_PROFILE } from "@accounts-proxy/provider-antigravity/domain/client-profile.ts";

/** Google OAuth client embedded in the Antigravity IDE (an installed-app client; RFC 8252 loopback redirect). */
export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
export const LOOPBACK_CALLBACK_PATH = "/oauth-callback";
export const SUCCESS_REDIRECT = "https://antigravity.google/auth-success?app=antigravity-ide";

/** Every /v1internal:* call in the source goes to the daily host (the stable host is declared but unused). */
export const DAILY_HOST = "https://daily-cloudcode-pa.googleapis.com";
/** UA law (source wire law 1): verbatim from the authorized capture; cloudcode-pa is client-gated on it. */
export const USER_AGENT = ANTIGRAVITY_PROFILE.userAgent;
export const IDE_METADATA = { ideType: ANTIGRAVITY_PROFILE.ideType, ideVersion: ANTIGRAVITY_PROFILE.ideVersion, ideName: ANTIGRAVITY_PROFILE.ideName } as const;

/** Source TokenLifecycleService / RefreshSessionUseCase.ensureFresh: refresh when ≤ 120 s remain. */
export const EXPIRY_BUFFER_MS = 120_000;
/** Source GoogleOAuthClientAdapter: expires_in default when the token response omits it. */
export const DEFAULT_EXPIRES_IN_S = 3600;
/** Source ModelCatalogService.IDE_WORKING_SET_CONTEXT_CAP (advertised-window law, measured 2026-10-04). */
export const IDE_WORKING_SET_CONTEXT_CAP = 80_000;
/** Source StreamChatUseCase LOCATION_RETRY_BACKOFF_MS (transient geo-gate law 14). */
export const LOCATION_RETRY_BACKOFF_MS: readonly number[] = [2000, 8000];
/** Source SignatureStoreAdapter: ~2000-entry oldest-eviction cap. */
export const SIGNATURE_CAP = 2000;
