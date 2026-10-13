// `login opencode` / `login opencode-go` (plan P4.6 amendment A). Both store the shared `opencode` account (K2).
//   OpencodeDeviceLogin  the Console device login (K1, Z17): the issued tokens, the user's identity (Z19) and the
//                        workspace's request headers (Z20)
//   OpencodeKeyLogin     a service-account key (K3, Z16) at the hidden prompt or imported (K5), checked by reading the
//                        workspace config with it (K4, Z20)
import { accountOwner, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import type { DeviceAuthorization } from "@inference-router/core/domain/device-flow.ts";
import { DeviceLoginClientPort, type DevicePoll } from "@inference-router/core/ports/outbound/device.ts";
import type { HashPort } from "@inference-router/core/ports/outbound/system.ts";
import { GatewayKeyLogin, type KeyIdentity } from "@inference-router/provider-gateway/adapters/outbound/gateway-key-login.ts";
import { encodeDevice, type ConsoleTokens, type OpencodeProvider } from "@inference-router/provider-opencode/domain/opencode.ts";
import type { ConsoleApiPort } from "@inference-router/provider-opencode/ports/outbound/console.ts";

export class OpencodeDeviceLogin extends DeviceLoginClientPort {
  constructor(
    readonly provider: OpencodeProvider,
    private readonly api: ConsoleApiPort,
  ) {
    super();
  }

  start(): Promise<DeviceAuthorization> {
    return this.api.deviceCode();
  }

  async poll(authorization: DeviceAuthorization): Promise<DevicePoll> {
    const answer = await this.api.deviceToken(authorization);
    return answer.kind === "tokens" ? this.signedIn(answer.tokens) : answer;
  }

  /** The approved login's account: identity (Z19) and the workspace's request headers (Z20). */
  private async signedIn(tokens: ConsoleTokens): Promise<DevicePoll> {
    const [identity, headers] = await Promise.all([this.api.identity(tokens), this.api.workspaceHeaders({ kind: "user", accessToken: tokens.accessToken, orgId: tokens.orgId })]);
    const account: AccountCredential = { provider: accountOwner(this.provider), id: identity.id, label: identity.label, data: encodeDevice(tokens, headers) };
    return { kind: "approved", account };
  }
}

export class OpencodeKeyLogin extends GatewayKeyLogin {
  readonly question = "OpenCode Console API key (opencode.ai Console → Keys → service account → Add API Key; starts oc_sk_): ";

  constructor(
    readonly provider: OpencodeProvider,
    hash: HashPort,
    private readonly api: ConsoleApiPort,
  ) {
    super(hash);
  }

  protected async identify(key: string): Promise<KeyIdentity> {
    const headers = await this.api.workspaceHeaders({ kind: "key", key });
    return { id: undefined, label: undefined, data: { workspaceHeaders: headers } };
  }
}
