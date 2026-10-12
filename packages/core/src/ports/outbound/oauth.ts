// OAuth browser-login ports (plan D10). OAuthClientPort is implemented once per provider; the loopback
// listener and the browser launcher are provider-independent.
import type { AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";

export type AuthorizeInput = {
  readonly redirectUri: string;
  readonly state: string;
  /** RFC 7636 S256 challenge; sent only by clients whose official client uses PKCE (Claude), ignored by the others. */
  readonly codeChallenge: string;
};

export type ExchangeInput = {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
  /** The verifier of codeChallenge (same rule). */
  readonly codeVerifier: string;
};

export abstract class OAuthClientPort {
  abstract readonly provider: ProviderId;
  /** Loopback callback path, e.g. "/callback" (Claude) or "/oauth-callback" (Google). */
  abstract readonly callbackPath: string;
  /** Redirect URI of the provider's paste-code page (headless fallback), or undefined if it has none. */
  abstract readonly manualRedirectUri: string | undefined;
  abstract authorizeUrl(input: AuthorizeInput): string;
  /** Exchange the code and build the stored account (tokens plus any provider bootstrap, e.g. project ids). */
  abstract exchange(input: ExchangeInput): Promise<AccountCredential>;
  /** Where the browser is redirected once the login has succeeded. */
  abstract successRedirect(account: AccountCredential): string;
}

export type CallbackQuery = Readonly<Record<string, string>>;

/** Loopback listener on 127.0.0.1. It holds the browser's request until `finish` answers it. */
export abstract class CallbackServerPort {
  /** Bind 127.0.0.1 on an ephemeral port serving `path`; returns the port. */
  abstract start(path: string): Promise<number>;
  abstract waitForCallback(timeoutMs: number): Promise<CallbackQuery>;
  abstract finish(answer: { readonly redirect: string } | { readonly status: number; readonly text: string }): Promise<void>;
  abstract stop(): Promise<void>;
}

/** A fresh loopback listener per login (a listener serves exactly one authorization). */
export abstract class CallbackServerFactoryPort {
  abstract create(): CallbackServerPort;
}

/** Headless fallback: obtain the code the provider's page displays. */
export abstract class ManualCodePort {
  abstract prompt(authorizeUrl: string): Promise<string>;
}
