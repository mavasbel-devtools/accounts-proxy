// OpenCode Console API (rules Z17–Z20): device authorization, device tokens and their renewal, the user's identity and
// the workspace config. Form-encoded token requests as in the Console API page's examples; every call is bounded by
// TOKEN_ENDPOINT_TIMEOUT_MS (plan v4 H-c).
import { TOKEN_ENDPOINT_TIMEOUT_MS } from "@accounts-proxy/core/domain/accounts.ts";
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import type { ClockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import {
  CLIENT_ID,
  CONFIG_PATH,
  consoleIdentity,
  DEVICE_CODE_PATH,
  DEVICE_GRANT,
  DEVICE_TOKEN_PATH,
  isInvalidGrant,
  ORGS_PATH,
  parseDeviceAuthorization,
  parseTokens,
  pollError,
  USER_AGENT,
  USER_PATH,
  workspaceHeaders,
  type ConsoleTokens,
  type WorkspaceHeaders,
} from "@accounts-proxy/provider-opencode/domain/opencode.ts";
import { ConsoleApiPort, type ConsoleAuth, type TokenPoll } from "@accounts-proxy/provider-opencode/ports/outbound/console.ts";

type Answer = { readonly status: number; readonly text: string; readonly json: unknown };

export class OpencodeConsoleClient extends ConsoleApiPort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly clock: ClockPort,
    /** `https://opencode.ai/console` (composition may repoint its origin to a test seam). */
    private readonly consoleUrl: string,
  ) {
    super();
  }

  async deviceCode(): Promise<DeviceAuthorization> {
    const answer = await this.form(DEVICE_CODE_PATH, { client_id: CLIENT_ID, supports_org_scope: "true" });
    if (answer.status !== 200) throw new UpstreamError("opencode", answer.status, answer.text);
    return parseDeviceAuthorization(answer.json, this.consoleUrl);
  }

  async deviceToken(authorization: DeviceAuthorization): Promise<TokenPoll> {
    const answer = await this.form(DEVICE_TOKEN_PATH, { grant_type: DEVICE_GRANT, device_code: authorization.deviceCode, client_id: CLIENT_ID });
    if (answer.status === 200) return { kind: "tokens", tokens: parseTokens(answer.json, this.clock.now()) };
    if (answer.status === 400) return { kind: pollError(answer.json) };
    throw new UpstreamError("opencode", answer.status, answer.text);
  }

  async refresh(tokens: ConsoleTokens): Promise<ConsoleTokens> {
    const answer = await this.form(DEVICE_TOKEN_PATH, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: CLIENT_ID });
    if (answer.status === 400 && isInvalidGrant(answer.json)) throw new ProviderAuthRequiredError("opencode", "the Console rejected the refresh token (invalid_grant)");
    if (answer.status !== 200) throw new UpstreamError("opencode", answer.status, answer.text);
    const renewed = parseTokens(answer.json, this.clock.now());
    // The workspace binding is preserved by a refresh (Console API page); an answer without org_id keeps the stored one.
    return renewed.orgId === undefined ? { ...renewed, orgId: tokens.orgId } : renewed;
  }

  async identity(tokens: ConsoleTokens): Promise<{ readonly id: string; readonly label: string }> {
    const auth: ConsoleAuth = { kind: "user", accessToken: tokens.accessToken, orgId: undefined };
    const [user, orgs] = await Promise.all([this.read(USER_PATH, auth), this.read(ORGS_PATH, auth)]);
    return consoleIdentity(user, orgs, tokens.orgId);
  }

  async workspaceHeaders(auth: ConsoleAuth): Promise<WorkspaceHeaders> {
    return workspaceHeaders(await this.read(CONFIG_PATH, auth));
  }

  /** A Console read; 401/403 mean the credential is refused (Console API page "Errors"). */
  private async read(path: string, auth: ConsoleAuth): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT, authorization: `Bearer ${auth.kind === "key" ? auth.key : auth.accessToken}` };
    // Z20: a user token names its workspace with x-org-id (400 OrgRequired otherwise).
    const orgId = auth.kind === "user" ? auth.orgId : undefined;
    if (orgId !== undefined) headers["x-org-id"] = orgId;
    const answer = await this.send({ method: "GET", url: `${this.consoleUrl}${path}`, headers, timeoutMs: TOKEN_ENDPOINT_TIMEOUT_MS });
    if (answer.status === 401 || answer.status === 403) throw new ProviderAuthRequiredError("opencode", `the Console refused the credential: HTTP ${answer.status} ${answer.text.slice(0, 200)}`);
    if (answer.status !== 200) throw new UpstreamError("opencode", answer.status, answer.text);
    return answer.json;
  }

  private form(path: string, fields: Record<string, string>): Promise<Answer> {
    return this.send({
      method: "POST",
      url: `${this.consoleUrl}${path}`,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
      body: new URLSearchParams(fields).toString(),
      timeoutMs: TOKEN_ENDPOINT_TIMEOUT_MS,
    });
  }

  /** The answer's status, text and JSON body (undefined when the body is not JSON: the parsers then report the missing fields). */
  private async send(request: Parameters<HttpTransportPort["send"]>[0]): Promise<Answer> {
    const res = await this.transport.send(request);
    const text = await readAll(res.body);
    return { status: res.status, text, json: jsonOrUndefined(text) };
  }
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
