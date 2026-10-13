// Sign in with ChatGPT for the e2e replay (live validation L4): one signing key (openai-id-token.ts) standing in for
// OpenAI's. OpenAI's live key set is committed (tests/fixtures/captures/p0-live/l4/openai-jwks.json: RS256 RSA keys with
// kid/use/alg); its private half is OpenAI's, so the replay signs with this key and publishes it the same way. The
// claim names are those of the live ID token of 2026-10-13 (iss, sub, aud[], nonce, auth_time, email, email_verified,
// name, sid, https://api.openai.com/auth, iat, exp, jti, at_hash); every value here is the replay's own.
import { IdTokenSigner } from "@inference-router/test-support/openai-id-token.ts";

const signer = new IdTokenSigner("e2e-key");

export const KID = signer.kid;
/** The scopes the live sign-in granted (accounts-openai.json, 2026-10-13). */
export const GRANTED_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

/** The published key set: `extra` keys, then the replay's signing key. */
export function jwks(extra: readonly Record<string, unknown>[] = []): { keys: Record<string, unknown>[] } {
  return signer.jwks(extra);
}

/** The replay's signing key as published (a JWK with kid, use and alg). */
export const signingKey = (): Record<string, unknown> => signer.jwks().keys[0]!;

/** An RS256 compact JWS over `claims`; `header` overrides the protected header (`kid: undefined` leaves it out). */
export function idToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  return signer.sign(claims, header);
}

/** The live claim set for one registration and sign-in attempt (`email` null: an ID token without the email claims). */
export function claims(clientId: string, nonce: string, subject = "e2e-subject", email: string | null = "e2e@example.com"): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://auth.openai.com",
    sub: subject,
    aud: [clientId],
    nonce,
    auth_time: now,
    ...(email !== null ? { email, email_verified: true, name: "E2E User" } : {}),
    sid: "e2e-sid",
    "https://api.openai.com/auth": { per_user_salt: "e2e-salt" },
    iat: now,
    exp: now + 3600,
    jti: "e2e-jti",
    at_hash: "e2e-at-hash",
  };
}
