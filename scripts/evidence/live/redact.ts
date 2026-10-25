// Redaction for P0-LIVE captures (plan 2026-10-07-01-23 §3). Every known secret value (held in memory only) is
// replaced by a fixed placeholder everywhere it occurs; credential-bearing header values and token-endpoint fields
// are replaced by name; identity fields and patterns remove the operator's account; then a scan refuses the output if
// any secret or a known token prefix survives.

import { loadRedactionManifest } from "@accounts-proxy/scripts/recon/shared/manifest.ts";

export type Secret = { readonly label: string; readonly value: string; readonly replacement: string };

// Credential names, identity names, value patterns and per-endpoint identity scopes come from the recon facility's
// manifest, the same JSON the capture addon reads, so the live-evidence redactor and the MITM capture cannot drift.
const manifest = loadRedactionManifest();

/** Header names whose whole value is a credential. */
const CREDENTIAL_HEADERS = new Set(manifest.credentialHeaders);
/** Header names whose value names the operator's account; the value becomes a known secret for the rest of the run. */
const IDENTITY_HEADERS = new Set(manifest.identityHeaders);
/** Query parameters whose value is a credential (an OAuth code, a signed link's `sig`). */
const QUERY_CREDENTIAL = new RegExp(
  `((?:^|[?&])(?:${manifest.queryCredentialFields.map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})=)[^&\\s"]+`,
  "g",
);
/** JSON field names whose string value is a credential wherever they appear ("code" is form-only: JSON error and tool
 * payloads legitimately carry a `code` field). */
const CREDENTIAL_FIELDS = new Set(manifest.credentialFields);
/** JSON field names that identify the operator's account rather than a secret. */
const IDENTITY_FIELDS = new Set(manifest.identityFields);
/** Value patterns (an email address is one wherever it appears, including inside prose). */
const IDENTITY_PATTERNS = manifest.identityPatterns.map((pattern) => ({
  name: pattern.name,
  regex: new RegExp(pattern.regex, "g"),
}));
/** Endpoint-scoped identity names: `id` and `name` are a person on a profile endpoint and a model or tool everywhere
 * else, so they are redacted only where the manifest says they are identity. */
const IDENTITY_SCOPED = manifest.identityScoped.map((scope) => ({
  host: scope.host,
  pathPrefix: scope.pathPrefix,
  fields: new Set(scope.fields),
}));
/**
 * Prefixes of live token formats: Anthropic OAuth / API keys, Google access tokens, Google refresh tokens, a JWS whose
 * header starts with `{"alg":` (OpenAI access and ID tokens are JWTs), and the gateway keys of plan P4.6: OpenRouter
 * `sk-or-` (openrouter-oauth-pkce.md), OpenCode Console `oc_sk_` (inference-proxy.ts), Cheaper Inference `ci_live_` and
 * legacy `ir_live_` ([api-keys]).
 */
export const TOKEN_PREFIXES: readonly string[] = manifest.tokenPrefixes;

/** Scoped identity field names for one URL, or an empty set when the URL is absent or unscoped. */
export function scopedIdentityFields(url: string | undefined): ReadonlySet<string> {
  if (url === undefined) return new Set();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Set();
  }
  const host = parsed.hostname.toLowerCase();
  const fields = new Set<string>();
  for (const scope of IDENTITY_SCOPED) {
    if (scope.host === host && parsed.pathname.startsWith(scope.pathPrefix)) {
      for (const field of scope.fields) fields.add(field);
    }
  }
  return fields;
}

export class Redactor {
  private readonly secrets: Secret[] = [];

  /** Values shorter than 6 characters are refused: replacing them would corrupt unrelated text. */
  add(label: string, value: string | undefined | null): void {
    if (value === undefined || value === null || value.length === 0) return;
    if (value.length < 6) throw new Error(`secret ${label} is too short to redact safely (${value.length} chars)`);
    if (this.secrets.some((s) => s.value === value)) return;
    this.secrets.push({ label, value, replacement: `<REDACTED:${label}>` });
    this.secrets.sort((a, b) => b.value.length - a.value.length);
  }

  /**
   * A known payload the repository already holds (a committed media fixture, base64): replaced by `<FIXTURE:label>`
   * so a capture names it instead of repeating it, and so its bytes cannot trip the token-prefix scan.
   */
  fixture(label: string, value: string): void {
    if (value.length < 6) throw new Error(`fixture ${label} is too short to substitute safely (${value.length} chars)`);
    if (this.secrets.some((s) => s.value === value)) return;
    this.secrets.push({ label, value, replacement: `<FIXTURE:${label}>` });
    this.secrets.sort((a, b) => b.value.length - a.value.length);
  }

  get size(): number {
    return this.secrets.length;
  }

  text(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s.value).join(s.replacement);
    for (const s of this.secrets) {
      const encoded = encodeURIComponent(s.value);
      if (encoded !== s.value) out = out.split(encoded).join(s.replacement);
    }
    out = out.replace(QUERY_CREDENTIAL, "$1<REDACTED:field>");
    for (const pattern of IDENTITY_PATTERNS) out = out.replace(pattern.regex, `<REDACTED:${pattern.name}>`);
    return out;
  }

  /** Plain records and the ordered header pairs the Claude client profile sends (wire.ts `orderedHeaders`), in order. */
  headers(headers: Readonly<Record<string, string>> | readonly (readonly [string, string])[]): Record<string, string> {
    const out: Record<string, string> = {};
    const entries = Array.isArray(headers) ? (headers as readonly (readonly [string, string])[]) : Object.entries(headers);
    for (const [name, value] of entries) {
      const key = name.toLowerCase();
      if (CREDENTIAL_HEADERS.has(key)) {
        const scheme = /^(Bearer|Basic)\s+/i.exec(value)?.[1];
        out[key] = scheme !== undefined ? `${scheme} <REDACTED:${key}>` : `<REDACTED:${key}>`;
      } else if (IDENTITY_HEADERS.has(key)) {
        if (value.length >= 6) this.add(key, value);
        out[key] = `<REDACTED:${key}>`;
      } else out[key] = this.nested(value, new Set(), 0);
    }
    return out;
  }

  /**
   * A body string: JSON is redacted structurally (credential and identity fields by name) and then textually. Passing
   * the request URL enables the endpoint-scoped identity rules; without it those rules simply do not apply.
   */
  body(input: string, url?: string): string {
    const scope = scopedIdentityFields(url);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return this.text(input);
    }
    return this.text(JSON.stringify(this.json(parsed, scope, 0)));
  }

  json(value: unknown, scope: ReadonlySet<string> = new Set(), depth = 0): unknown {
    if (Array.isArray(value)) return value.map((v) => this.json(v, scope, depth));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const named = CREDENTIAL_FIELDS.has(k) || IDENTITY_FIELDS.has(k) || scope.has(k);
        out[k] = named && typeof v === "string" ? `<REDACTED:${k}>` : this.json(v, scope, depth);
      }
      return out;
    }
    if (typeof value === "string") return this.nested(value, scope, depth);
    return value;
  }

  /** A string value that is itself JSON (Claude's `metadata.user_id` is one) is redacted as the object it encodes. */
  private nested(input: string, scope: ReadonlySet<string>, depth: number): string {
    const text = this.text(input);
    if (depth >= 4) return text;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
    try {
      return JSON.stringify(this.json(JSON.parse(trimmed), scope, depth + 1) as unknown);
    } catch {
      return text;
    }
  }

  /** Every surviving secret label or token prefix in `output`; an empty list means the output may be written. */
  scan(output: string): string[] {
    const hits: string[] = [];
    for (const s of this.secrets) if (output.includes(s.value)) hits.push(`secret:${s.label}`);
    for (const prefix of TOKEN_PREFIXES) if (output.includes(prefix)) hits.push(`prefix:${prefix}`);
    return hits;
  }
}
