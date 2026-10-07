// Pure OAuth browser-login rules shared by every provider.
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";

export type LoopbackCallback = Readonly<Record<string, string>>;

/** Loopback redirect URI for a listener port and callback path (RFC 8252 §7.3; both providers redirect to `localhost`). */
export function loopbackRedirectUri(port: number, path: string): string {
  return `http://localhost:${port}${path}`;
}

/**
 * Validate a loopback callback (RFC 6749 §4.1.2 / §4.1.2.1): an `error` parameter, a state mismatch (CSRF) or a
 * missing code fail the login; otherwise the authorization code is returned.
 */
export function codeFromCallback(provider: ProviderId, query: LoopbackCallback, expectedState: string): string {
  if (query["error"] !== undefined) {
    const description = query["error_description"];
    throw new ProviderAuthRequiredError(provider, `authorization failed: ${query["error"]}${description ? ` (${description})` : ""}`);
  }
  if (query["state"] !== expectedState) throw new ProviderAuthRequiredError(provider, "authorization state mismatch");
  const code = query["code"];
  if (code === undefined || code === "") throw new ProviderAuthRequiredError(provider, "authorization code missing from the callback");
  return code;
}

/**
 * Headless paste-code input. Claude's code page shows `code#state` (source opencode-claude-auth AGENTS.md §10:
 * strip only the suffix after the final `#`); a present suffix must equal the expected state.
 */
export function codeFromManualInput(provider: ProviderId, input: string, expectedState: string): string {
  const trimmed = input.trim();
  const hash = trimmed.lastIndexOf("#");
  const code = hash < 0 ? trimmed : trimmed.slice(0, hash);
  if (hash >= 0 && trimmed.slice(hash + 1) !== expectedState) throw new ProviderAuthRequiredError(provider, "authorization state mismatch");
  if (code === "") throw new ProviderAuthRequiredError(provider, "no authorization code entered");
  return code;
}
