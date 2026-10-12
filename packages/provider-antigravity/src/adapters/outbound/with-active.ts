// Source RefreshSessionUseCase.withActiveTokens: run a call with the fresh active account; on an upstream 401
// force-rotate ONCE and retry (the stored expiry is a local-clock prediction and can be wrong after clock skew).
import { isUnauthorized } from "@inference-router/provider-antigravity/domain/upstream.ts";
import type { ActiveAccount, AntigravitySessionPort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export async function withActive<T>(session: AntigravitySessionPort, call: (active: ActiveAccount) => Promise<T>): Promise<T> {
  const active = await session.active();
  try {
    return await call(active);
  } catch (error) {
    if (!isUnauthorized(error) || active.account.tokens.refreshToken === undefined) throw error;
    return call(await session.forceRenew(active));
  }
}
