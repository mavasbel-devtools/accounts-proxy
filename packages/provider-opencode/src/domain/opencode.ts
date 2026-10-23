// OpenCode Console rules for Zen (`opencode`) and Go (`opencode-go`) after the 2026-10-12 Console migration (rules
// document 2026-10-12-15-35-gateway-provider-rules.md §3a, Z12–Z23; §3 Z4–Z6, Z8 and Z9 still hold). Pure.
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ReferenceModel } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import type { DeviceAuthorization } from "@accounts-proxy/core/domain/device-flow.ts";
import { asArray, asObject, firstString, gatewayModel, positiveInteger, type GatewayModel, type GatewaySpec } from "@accounts-proxy/provider-gateway/domain/gateway.ts";

export type OpencodeProvider = Extract<ProviderId, "opencode" | "opencode-go">;
export const OPENCODE_PROVIDERS: readonly OpencodeProvider[] = ["opencode", "opencode-go"];

export const OPENCODE_ORIGIN = "https://opencode.ai";
/** The Console: device login, identity and workspace config (Z17–Z20). */
export const CONSOLE_URL = `${OPENCODE_ORIGIN}/console`;
/** The proxy's own device-login client id (decision K1; the Console API page has other CLIs use their own). */
export const CLIENT_ID = "accounts-proxy";
export const DEVICE_CODE_PATH = "/auth/device/code";
export const DEVICE_TOKEN_PATH = "/auth/device/token";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const USER_PATH = "/api/user";
export const ORGS_PATH = "/api/orgs";
export const CONFIG_PATH = "/api/v2/config";

/** Z15, Z26: the proxy's name and version (apps/proxy/package.json), sent when the client sends no User-Agent. */
export const USER_AGENT = "accounts-proxy/0.1.0";
/** Z15: the conversation id the client sends, forwarded as it is. */
export const SESSION_HEADER = "x-opencode-session";
/**
 * Z26, recon gap O2: OpenCode's own request headers, forwarded as they are when the client sends them — its User-Agent
 * (the free models answer only OpenCode's own), its trace context and its session, project and client ids (opencode
 * v2.1.1 `packages/core/src/session/model-request.ts:281-292`; captured on every inference request,
 * recon run opencode/2026-10-23-03-50-16). The proxy never invents them.
 */
const CLIENT_HEADERS = [
  "user-agent",
  "b3",
  "traceparent",
  "x-opencode-client",
  "x-opencode-project",
  SESSION_HEADER,
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
];
/** Z9: the gateway's request id response header. */
const LOG_ID = "x-opencode-log-id";

/**
 * Z12, Z14, recon gaps O1, O4: the endpoints and key headers OpenCode v2.1.1 uses (models.opencode.ai `api` per
 * provider and package; captured in recon runs opencode/2026-10-23-03-50-* and -03-51-*): a bearer token on Chat,
 * Responses and Messages, Gemini's `x-goog-api-key` on Gemini. Zen under `/inference/`, Go under `/inference/go/`.
 */
function consoleEndpoints(): GatewaySpec["endpoints"] {
  return {
    "openai-chat": { path: "/openai/v1/chat/completions" },
    "openai-responses": { path: "/openai/v1/responses" },
    "anthropic-messages": { path: "/anthropic/v1/messages" },
    gemini: { path: "/google/v1beta/models", keyHeader: "x-goog-api-key" },
  };
}

export const ZEN_SPEC: GatewaySpec = {
  provider: "opencode",
  apiBase: `${OPENCODE_ORIGIN}/inference`,
  endpoints: consoleEndpoints(),
  requestIdHeader: LOG_ID,
  headers: { "user-agent": USER_AGENT },
  forwardHeaders: CLIENT_HEADERS,
  forwardAccept: false,
  sessionHeader: SESSION_HEADER,
};

/** Z13 as amended by recon gap O1: Go serves the same four families under `/inference/go/` (Gemini included). */
export const GO_SPEC: GatewaySpec = {
  provider: "opencode-go",
  apiBase: `${OPENCODE_ORIGIN}/inference/go`,
  endpoints: consoleEndpoints(),
  requestIdHeader: LOG_ID,
  headers: { "user-agent": USER_AGENT },
  forwardHeaders: CLIENT_HEADERS,
  forwardAccept: false,
  sessionHeader: SESSION_HEADER,
};

/** Z5: the AI SDK package of a model → its format. */
const NPM_FORMAT: ReadonlyMap<string, WireFormat> = new Map([
  ["@ai-sdk/openai", "openai-responses"],
  ["@ai-sdk/anthropic", "anthropic-messages"],
  ["@ai-sdk/google", "gemini"],
  ["@ai-sdk/openai-compatible", "openai-chat"],
  ["@ai-sdk/mistral", "openai-chat"],
]);

/**
 * Z5, recon gap O5: the provider's models are the reference catalog's entries for it (models.opencode.ai, the list
 * OpenCode itself loads at every start, plan 2026-10-16 C3); OpenCode never reads the gateway's `GET /v1/models` (0 of
 * the recon runs), so the proxy does not either. Each model's format comes from its AI SDK package (the per-model
 * `provider.npm`, else the provider's `npm`; an unknown or absent package: formats unknown, Z6). The names, limits and
 * the rest come from the same catalog when the list is described (rule M1).
 */
export function referenceModels(entries: ReadonlyMap<string, ReferenceModel>): GatewayModel[] {
  return [...entries].map(([id, model]) => {
    const format = model.aiSdkPackage === undefined ? undefined : NPM_FORMAT.get(model.aiSdkPackage);
    return gatewayModel({ id, displayName: id, contextWindow: undefined, maxOutputTokens: undefined, createdSeconds: undefined, formats: format === undefined ? undefined : [format] });
  });
}

// ---- Device login (Z17–Z19) ----

/** Z17: the device-code answer; `verification_uri_complete` is resolved against the Console URL (opencode.ts `authorize`). */
export function parseDeviceAuthorization(value: unknown, consoleUrl: string): DeviceAuthorization {
  const body = asObject(value);
  const deviceCode = firstString(body["device_code"]);
  const userCode = firstString(body["user_code"]);
  const verification = firstString(body["verification_uri_complete"]);
  const interval = positiveInteger(body["interval"]);
  const expiresIn = positiveInteger(body["expires_in"]);
  // opencode.ts `authorize`: the page must be an HTTP(S) URL (it is opened in the browser).
  const url = verification === undefined ? undefined : new URL(verification, `${consoleUrl}/`);
  if (deviceCode === undefined || userCode === undefined || url === undefined || !["http:", "https:"].includes(url.protocol) || interval === undefined || expiresIn === undefined) {
    throw new UpstreamError("opencode", 502, `the device authorization answer lacks a field or names a non-HTTP page: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { deviceCode, userCode, verificationUrl: url.href, intervalMs: interval * 1000, expiresInMs: expiresIn * 1000 };
}

/** A Console session's tokens (Z17, Z18); `orgId`: the workspace the token is bound to. */
export type ConsoleTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly orgId: string | undefined;
};

/** Z17, Z18: a token answer → tokens; UpstreamError when a field is missing. */
export function parseTokens(value: unknown, now: number): ConsoleTokens {
  const body = asObject(value);
  const accessToken = firstString(body["access_token"]);
  const refreshToken = firstString(body["refresh_token"]);
  const expiresIn = positiveInteger(body["expires_in"]);
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new UpstreamError("opencode", 502, `token answer lacks a field: ${JSON.stringify(Object.keys(body))}`);
  }
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, orgId: firstString(body["org_id"]) };
}

/** Z17 (RFC 8628 §3.5): a 400 device-token answer → still pending, slow down, or the end of the authorization. */
export function pollError(value: unknown): "pending" | "slow_down" {
  const error = firstString(asObject(value)["error"]);
  if (error === "authorization_pending") return "pending";
  if (error === "slow_down") return "slow_down";
  throw new ProviderAuthRequiredError("opencode", `device authorization ended: ${error ?? "no error code"}`);
}

/** Z18 (opencode.ts `refresh`): a 400 `invalid_grant` refresh answer means the session is gone (a new login is needed). */
export function isInvalidGrant(value: unknown): boolean {
  return asObject(value)["error"] === "invalid_grant";
}

/** Z19 (opencode.ts `credential`): the account id `<email>/<workspace id>` and the label `<email> (<workspace name>)`. */
export function consoleIdentity(user: unknown, orgs: unknown, orgId: string | undefined): { readonly id: string; readonly label: string } {
  const u = asObject(user);
  const email = firstString(u["email"], u["id"]);
  if (email === undefined) throw new UpstreamError("opencode", 502, "the Console user answer has no email or id");
  if (orgId === undefined) return { id: email, label: email };
  const org = asArray(orgs)
    .map(asObject)
    .find((o) => o["id"] === orgId);
  return { id: `${email}/${orgId}`, label: `${email} (${firstString(org?.["name"], orgId)})` };
}

// ---- Workspace config (Z20) ----

/** The workspace's request headers for each OpenCode provider (string values only). */
export type WorkspaceHeaders = Readonly<Partial<Record<OpencodeProvider, Readonly<Record<string, string>>>>>;

/** Z20: `providers.<id>.headers` of the workspace config, for the two OpenCode providers. */
export function workspaceHeaders(config: unknown): WorkspaceHeaders {
  const providers = asObject(asObject(config)["providers"]);
  const out: Partial<Record<OpencodeProvider, Record<string, string>>> = {};
  for (const provider of OPENCODE_PROVIDERS) {
    const entry = providers[provider];
    if (entry === undefined) continue;
    out[provider] = Object.fromEntries(Object.entries(asObject(asObject(entry)["headers"])).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  }
  return out;
}

// ---- Stored accounts ----

/** A stored Console account: a service-account key (`apiKey`), or device-login tokens; both carry the workspace headers. */
export type ConsoleCredential = { readonly kind: "key"; readonly key: string; readonly headers: WorkspaceHeaders } | { readonly kind: "device"; readonly tokens: ConsoleTokens; readonly headers: WorkspaceHeaders };

export function decodeCredential(data: JsonObject): ConsoleCredential | undefined {
  const headers = decodeHeaders(data["workspaceHeaders"]);
  const key = firstString(data["apiKey"]);
  if (key !== undefined) return { kind: "key", key, headers };
  const accessToken = firstString(data["accessToken"]);
  const refreshToken = firstString(data["refreshToken"]);
  const expiresAt = data["expiresAt"];
  if (accessToken === undefined || refreshToken === undefined || typeof expiresAt !== "number") return undefined;
  return { kind: "device", tokens: { accessToken, refreshToken, expiresAt, orgId: firstString(data["orgId"]) }, headers };
}

export function encodeDevice(tokens: ConsoleTokens, headers: WorkspaceHeaders): JsonObject {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.orgId !== undefined ? { orgId: tokens.orgId } : {}),
    workspaceHeaders: headers,
  };
}

function decodeHeaders(value: unknown): WorkspaceHeaders {
  const stored = asObject(value);
  return workspaceHeaders({ providers: Object.fromEntries(Object.entries(stored).map(([provider, headers]) => [provider, { headers }])) });
}
