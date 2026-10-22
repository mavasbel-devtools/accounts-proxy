// Canonical form of one upstream request, so a real client's request (plane A, recorded by the recon addon) and the
// proxy's request for the same logical call (plane B, recorded by the wire tap) can be compared field by field.
//
// Canonicalisation only removes what cannot be equal between two independent runs, and says so with a named
// placeholder: the origin (the tap is loopback, the client talked to the provider), message lengths, identifiers minted
// per request or per session, timestamps, and values the recon redactor already replaced. Everything else — header
// names, their case and order, every body field and value — is kept, because that is what an upstream can observe.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One request as it went on the wire. Header pairs are in wire order, with the case they were sent in. */
export type WireRequest = {
  readonly method: string;
  /** Absolute URL or origin-relative target. */
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  readonly httpVersion?: string;
};

export type CanonicalHeader = { readonly name: string; readonly raw: string; readonly value: string };

export type CanonicalRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
  readonly headers: readonly CanonicalHeader[];
  /** Parsed and masked JSON when the body is JSON, else the masked text; `null` for an empty body. */
  readonly body: unknown;
};

/** Placeholder for a value the recon redactor replaced: it matches any value of the same JSON type. */
export const REDACTED = "<redacted>";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REDACTED_MARK = /^<REDACTED:[^>]*>$/;
const EPOCH_MS = /(?<![0-9])1[0-9]{12}(?![0-9])/g;
const INT64 = /^-?[0-9]{15,20}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

type Manifest = { readonly credentialHeaders: readonly string[]; readonly credentialFields: readonly string[]; readonly identityFields: readonly string[] };
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "shared", "redaction.json"), "utf8")) as Manifest;
const CREDENTIAL_HEADERS = new Set(manifest.credentialHeaders.map((name) => name.toLowerCase()));
/**
 * Fields that name a person, an install or a secret are compared by presence and type only, on both sides: a capture
 * recorded before a manifest rule existed still holds the raw value, and the proxy's own value is a different
 * account's. Neither may reach a report.
 */
const IDENTITY_FIELDS = new Set([...manifest.identityFields, ...manifest.credentialFields]);
const MESSAGE_ID = /\bmsg_[A-Za-z0-9]{16,}\b/g;

/**
 * Headers whose value is a property of the connection or of the message length, not of the client: `host` names the
 * tap on plane B, `content-length` follows any byte of the body, and the body is compared on its own.
 */
const TRANSPORT_VALUE_HEADERS = new Set(["host", "content-length"]);

/** A string value with per-run parts named instead of compared. */
export function maskString(value: string): string {
  if (REDACTED_MARK.test(value)) return REDACTED;
  if (ISO_TIME.test(value)) return "<iso-time>";
  if (INT64.test(value)) return "<int64>";
  return value.replace(UUID, "<uuid>").replace(EPOCH_MS, "<epoch-ms>").replace(MESSAGE_ID, "<message-id>").replace(/<REDACTED:[^>]*>/g, REDACTED);
}

/** JSON carried inside a string (Claude's `metadata.user_id`) is compared as JSON. */
function maskJsonString(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return { $json: maskValue(JSON.parse(trimmed) as unknown) };
    } catch {
      return maskString(value);
    }
  }
  return maskString(value);
}

export function maskValue(value: unknown): unknown {
  if (typeof value === "string") return maskJsonString(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = IDENTITY_FIELDS.has(key) && typeof item === "string" ? REDACTED : maskValue(item);
    return out;
  }
  return value;
}

function headerValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (TRANSPORT_VALUE_HEADERS.has(lower)) return `<${lower}>`;
  if (CREDENTIAL_HEADERS.has(lower)) {
    const scheme = /^(Bearer|Basic)\s+/i.exec(value);
    return scheme ? `${scheme[1]} ${REDACTED}` : REDACTED;
  }
  return maskString(value);
}

function body(text: string): unknown {
  if (text === "") return null;
  try {
    return maskValue(JSON.parse(text) as unknown);
  } catch {
    return maskString(text);
  }
}

export function canonicalise(request: WireRequest): CanonicalRequest {
  const url = new URL(request.url, "http://origin.invalid");
  const query = [...url.searchParams.entries()].map(([key, value]) => [key, maskString(value)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    query,
    headers: request.headers.map(([raw, value]) => ({ name: raw.toLowerCase(), raw, value: headerValue(raw, value) })),
    body: body(request.body),
  };
}
