// Shared rules of the API-key gateways (plan P4.6 §2 item 6; rules document 2026-10-12-15-35-gateway-provider-rules.md
// §5 G1–G4). Pure: a vendor package supplies a GatewaySpec; the adapters do the I/O.
import { InvalidRequestError, UnsupportedFeatureError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject, type JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ModelDetails } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { parseJsonBody } from "@accounts-proxy/core/domain/services/json-body.ts";
import type { RawRequest } from "@accounts-proxy/core/domain/wire.ts";

/** Every gateway takes its key as `Authorization: Bearer <key>` (R1, C1, Z14). */
export type Endpoint = {
  /** Path under the spec's `apiBase`; for `gemini`, the prefix `/<model>:<method>` is appended to. */
  readonly path: string;
};

export type GatewaySpec = {
  readonly provider: ProviderId;
  /** Production API base, e.g. `https://openrouter.ai/api/v1` (composition may repoint its origin to a test seam). */
  readonly apiBase: string;
  /** The vendor endpoint of each format it serves; a format without one has no native route here. */
  readonly endpoints: Readonly<Partial<Record<WireFormat, Endpoint>>>;
  /** Anthropic `count_tokens`, where the vendor has it (Cheaper C2). */
  readonly countTokens?: Endpoint;
  /** Formats every model accepts natively, when the vendor serves all of them for every model (OpenRouter R2). */
  readonly uniformFormats?: readonly WireFormat[];
  /** The vendor's request-id response header, forwarded to the client (G3). */
  readonly requestIdHeader: string;
  /** Headers sent on every request (OpenCode's own client identification, Z15). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Client request headers forwarded as they are, when present (OpenCode's `x-opencode-session`, Z15). */
  readonly forwardHeaders?: readonly string[];
  /**
   * The vendor's per-conversation session header (OpenCode's `x-opencode-session`, Z24): when the client did not send it,
   * the proxy sends the conversation's own id, else a stable id derived from the conversation's first user turn.
   */
  readonly sessionHeader?: string;
};

/** One model of a gateway catalog. `formats` absent: not known (the request is forwarded as sent, Z6). */
export type GatewayModel = {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly createdAt?: string;
  readonly formats?: readonly WireFormat[];
  /** What the vendor's list states beyond these fields (plan 2026-10-16 C3). */
  readonly details?: ModelDetails;
};

export type UpstreamCall = {
  readonly url: string;
  /** Every request header except the key (G2). */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

const GEMINI_METHODS = ["generateContent", "streamGenerateContent"];
const GEMINI_ROUTE = /^\/v1beta\/models\/.+:([A-Za-z]+)$/;

/** The upstream request for a native call: endpoint (G4), body `model` replaced by the bare id (G1), headers (G2). */
export function upstreamCall(spec: GatewaySpec, model: string, request: RawRequest): UpstreamCall {
  const endpoint = endpointFor(spec, request);
  const headers: Record<string, string> = { ...spec.headers, "content-type": "application/json" };
  const forwarded = request.format === "anthropic-messages" ? ["accept", "anthropic-version", "anthropic-beta"] : ["accept"];
  for (const name of [...forwarded, ...(spec.forwardHeaders ?? [])]) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (spec.sessionHeader !== undefined && headers[spec.sessionHeader] === undefined) {
    const id = conversationId(request.format, request.body);
    if (id !== undefined) headers[spec.sessionHeader] = id;
  }
  if (request.format === "gemini") {
    const method = GEMINI_ROUTE.exec(request.path)![1]!;
    const alt = request.query["alt"];
    const url = `${spec.apiBase}${endpoint.path}/${encodeURIComponent(model)}:${method}${alt !== undefined ? `?alt=${encodeURIComponent(alt)}` : ""}`;
    return { url, headers, body: request.body };
  }
  // The route handler forwards only a JSON object with a string `model` on these formats.
  const parsed = parseJsonBody(request.body) as JsonObject;
  return { url: `${spec.apiBase}${endpoint.path}`, headers, body: JSON.stringify({ ...parsed, model }) };
}

function endpointFor(spec: GatewaySpec, request: RawRequest): Endpoint {
  const endpoint = spec.endpoints[request.format];
  if (endpoint === undefined) throw new UnsupportedFeatureError([`${request.format}_format`], `${spec.provider} (no native endpoint for this format; the proxy does not translate between formats)`);
  if (request.format === "anthropic-messages") {
    if (request.path === "/v1/messages") return endpoint;
    if (request.path === "/v1/messages/count_tokens") {
      if (spec.countTokens === undefined) throw new UnsupportedFeatureError(["count_tokens"], spec.provider);
      return spec.countTokens;
    }
    throw new InvalidRequestError(`${spec.provider} has no native route ${request.path}`);
  }
  if (request.format === "gemini") {
    // The route handler gives the gemini format only to `/v1beta/models/<model>:<method>` paths.
    const method = GEMINI_ROUTE.exec(request.path)![1]!;
    if (!GEMINI_METHODS.includes(method)) throw new UnsupportedFeatureError([method], spec.provider);
  }
  return endpoint;
}

/** The key's request header (R1, C1, Z14). */
export function keyHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** G3: the status and body pass through; these response headers reach the client. */
export function forwardedResponseHeaders(spec: GatewaySpec, headers: Readonly<Record<string, string>>): Record<string, string> {
  const keep = ["content-type", "retry-after", spec.requestIdHeader];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (keep.includes(key)) out[key] = value;
  }
  return out;
}

/** Only the formats the spec has an endpoint for (a vendor list may name others, e.g. legacy `/v1/completions`). */
export function servedFormats(spec: GatewaySpec, formats: readonly WireFormat[]): WireFormat[] {
  return formats.filter((f) => spec.endpoints[f] !== undefined);
}

/** Cached model list (G5). Version 2 (plan 2026-10-16 C3): the details; a version-1 copy is not reused. */
export type CatalogSnapshot = { readonly version: 2; readonly fetchedAt: number; readonly models: readonly GatewayModel[] };

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 30_000;

const FORMATS: readonly string[] = ["anthropic-messages", "openai-chat", "openai-responses", "gemini"];

function isGatewayModel(value: unknown): value is GatewayModel {
  if (!isJsonObject(value) || typeof value["id"] !== "string" || typeof value["displayName"] !== "string") return false;
  const formats = value["formats"];
  return formats === undefined || (Array.isArray(formats) && formats.every((f) => typeof f === "string" && FORMATS.includes(f)));
}

export function isCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  return (
    isJsonObject(value) &&
    value["version"] === 2 &&
    typeof value["fetchedAt"] === "number" &&
    Array.isArray(value["models"]) &&
    value["models"].every(isGatewayModel)
  );
}

/** A positive integer from a catalog field, else undefined. */
export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The fields of a gateway model row; `createdSeconds` is the vendor's Unix creation time (OpenRouter R4). */
export type GatewayModelFields = {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly createdSeconds: number | undefined;
  readonly formats: readonly WireFormat[] | undefined;
  readonly details?: ModelDetails | undefined;
};

/** A GatewayModel without the fields the vendor did not state (exact optional property types). */
export function gatewayModel(fields: GatewayModelFields): GatewayModel {
  return {
    id: fields.id,
    displayName: fields.displayName,
    ...(fields.contextWindow !== undefined ? { contextWindow: fields.contextWindow } : {}),
    ...(fields.maxOutputTokens !== undefined ? { maxOutputTokens: fields.maxOutputTokens } : {}),
    ...(fields.createdSeconds !== undefined ? { createdAt: new Date(fields.createdSeconds * 1000).toISOString() } : {}),
    ...(fields.formats !== undefined ? { formats: fields.formats } : {}),
    ...(fields.details !== undefined ? { details: fields.details } : {}),
  };
}

// Readers for vendor JSON, shared by every gateway parser: a field of the wrong type reads as absent.

export function asObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The first non-empty string among `values`. */
export function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v !== "") as string | undefined;
}

/** The rows of a list that are objects with a string `id`. */
export function rowsWithId(list: unknown): readonly JsonObject[] {
  return asArray(list).map(asObject).filter((r) => typeof r["id"] === "string");
}

/** A report of the `fields` the vendor answered, one `name: JSON value` line each (quota reports). */
export function fieldsText(title: string, data: JsonObject, fields: readonly string[]): string {
  return [title, ...fields.filter((f) => f in data).map((f) => `  ${f}: ${JSON.stringify(data[f])}`)].join("\n");
}

/**
 * Z24: a stable id for the conversation a request belongs to (clients resend the whole history, so its first user turn is
 * the same on every request of a conversation). The client's own conversation id wins: Claude Code's session in
 * `metadata.user_id` (`…_session_<uuid>`, L3 capture 2026-10-13) and the Responses `prompt_cache_key` (opencode sets it
 * to its session affinity, model-request.ts). Otherwise `ap_` + a 64-bit FNV-1a hash of the first user turn; undefined
 * when the body has none.
 */
export function conversationId(format: WireFormat, body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const userId = isJsonObject(parsed["metadata"]) ? parsed["metadata"]["user_id"] : undefined;
  const session = typeof userId === "string" ? /_session_([0-9A-Za-z-]+)$/.exec(userId)?.[1] : undefined;
  if (format === "anthropic-messages" && session !== undefined) return session;
  const cacheKey = parsed["prompt_cache_key"];
  if (format === "openai-responses" && typeof cacheKey === "string" && cacheKey !== "") return cacheKey;
  const first = firstUserTurn(format, parsed);
  return first === undefined ? undefined : `ap_${fnv1a64(JSON.stringify(first))}`;
}

/** A user turn: role `user`, or (Gemini contents) neither role nor item type. */
const isUser = (item: unknown) => isJsonObject(item) && (item["role"] === "user" || (item["role"] === undefined && item["type"] === undefined));

function firstUserTurn(format: WireFormat, body: JsonObject): unknown {
  if (format === "gemini") return Array.isArray(body["contents"]) ? body["contents"].find(isUser) : undefined;
  if (format === "openai-responses") {
    const input = body["input"];
    return typeof input === "string" ? input : Array.isArray(input) ? input.find(isUser) : undefined;
  }
  const messages = body["messages"];
  return Array.isArray(messages) ? messages.find((m) => isJsonObject(m) && m["role"] === "user") : undefined;
}

/** 64-bit FNV-1a over the UTF-16 code units, as 16 hex digits (an id, not a secret). */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
