// OpenCode Console abstractions (plan P4.6 amendment A). The device login, the key login and the session depend only on
// these; OpencodeConsoleClient implements the Console API, composition wires it.
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import type { DevicePoll } from "@accounts-proxy/core/ports/outbound/device.ts";
import type { OAuthSessionPort } from "@accounts-proxy/core/ports/outbound/session.ts";
import type { ConsoleCredential, ConsoleTokens, WorkspaceHeaders } from "@accounts-proxy/provider-opencode/domain/opencode.ts";

/** A device-token poll before the account is built: still waiting, slow down, or the issued tokens. */
export type TokenPoll = Exclude<DevicePoll, { readonly kind: "approved" }> | { readonly kind: "tokens"; readonly tokens: ConsoleTokens };

/** The credential a Console call carries: a service-account key, or a user's access token bound to a workspace. */
export type ConsoleAuth = { readonly kind: "key"; readonly key: string } | { readonly kind: "user"; readonly accessToken: string; readonly orgId: string | undefined };

export abstract class ConsoleApiPort {
  /** Z17: a new device authorization under the proxy's client id. */
  abstract deviceCode(): Promise<DeviceAuthorization>;
  /** Z17: one device-token poll. */
  abstract deviceToken(authorization: DeviceAuthorization): Promise<TokenPoll>;
  /** Z18: one refresh; ProviderAuthRequiredError when the grant is rejected. */
  abstract refresh(tokens: ConsoleTokens): Promise<ConsoleTokens>;
  /** Z19: the signed-in user's account id and label. */
  abstract identity(tokens: ConsoleTokens): Promise<{ readonly id: string; readonly label: string }>;
  /** Z20: the workspace config's request headers; ProviderAuthRequiredError when the credential is refused. */
  abstract workspaceHeaders(auth: ConsoleAuth): Promise<WorkspaceHeaders>;
}

/** The shared Console session of `opencode` and `opencode-go` (decision K2). */
export type ConsoleSessionPort = OAuthSessionPort<ConsoleCredential>;
