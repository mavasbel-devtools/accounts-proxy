// Device-authorization login (RFC 8628; plan P4.6 amendment A, decision K1): the user approves a code on the provider's
// page while the proxy polls the token endpoint. DeviceLoginClientPort is implemented once per provider that has it.
import type { AccountCredential } from "@accounts-proxy/core/domain/accounts.ts";
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

/** One poll of the token endpoint (RFC 8628 §3.5): still waiting, asked to poll slower, or approved. */
export type DevicePoll = { readonly kind: "pending" } | { readonly kind: "slow_down" } | { readonly kind: "approved"; readonly account: AccountCredential };

export abstract class DeviceLoginClientPort {
  abstract readonly provider: ProviderId;
  abstract start(): Promise<DeviceAuthorization>;
  /** One token request; throws when the provider ends the authorization (denied, expired, any other error). */
  abstract poll(authorization: DeviceAuthorization): Promise<DevicePoll>;
}
