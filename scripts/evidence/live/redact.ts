// Redaction for P0-LIVE captures (plan 2026-10-07-01-23 §3). Every known secret value (held in memory only) is
// replaced by a fixed placeholder everywhere it occurs; credential-bearing header values and token-endpoint fields
// are replaced by name; then a scan refuses the output if any secret or a known token prefix survives.

export type Secret = { readonly label: string; readonly value: string };

/** Header names whose whole value is a credential. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "cookie", "set-cookie"]);
/** JSON field names whose string value is a credential wherever they appear ("code" is form-only: JSON error and tool
 * payloads legitimately carry a `code` field). */
const CREDENTIAL_FIELDS = new Set(["access_token", "refresh_token", "id_token", "code_verifier", "client_secret"]);
/**
 * Prefixes of live token formats: Anthropic OAuth / API keys, Google access tokens, Google refresh tokens, a JWS whose
 * header starts with `{"alg":` (OpenAI access and ID tokens are JWTs), and the gateway keys of plan P4.6: OpenRouter
 * `sk-or-` (openrouter-oauth-pkce.md), OpenCode Console `oc_sk_` (inference-proxy.ts), Cheaper Inference `ci_live_` and
 * legacy `ir_live_` ([api-keys]).
 */
export const TOKEN_PREFIXES: readonly string[] = ["sk-ant-", "ya29.", "1//", "eyJhbGci", "sk-or-", "oc_sk_", "ci_live_", "ir_live_"];

export class Redactor {
  private readonly secrets: Secret[] = [];

  /** Values shorter than 6 characters are refused: replacing them would corrupt unrelated text. */
  add(label: string, value: string | undefined | null): void {
    if (value === undefined || value === null || value.length === 0) return;
    if (value.length < 6) throw new Error(`secret ${label} is too short to redact safely (${value.length} chars)`);
    if (this.secrets.some((s) => s.value === value)) return;
    this.secrets.push({ label, value });
    this.secrets.sort((a, b) => b.value.length - a.value.length);
  }

  get size(): number {
    return this.secrets.length;
  }

  text(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s.value).join(`<REDACTED:${s.label}>`);
    for (const s of this.secrets) {
      const encoded = encodeURIComponent(s.value);
      if (encoded !== s.value) out = out.split(encoded).join(`<REDACTED:${s.label}>`);
    }
    return out.replace(/((?:^|[?&])(?:access_token|refresh_token|id_token|code|code_verifier|client_secret)=)[^&\s"]+/g, "$1<REDACTED:field>");
  }

  headers(headers: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (CREDENTIAL_HEADERS.has(key)) {
        const scheme = /^(Bearer|Basic)\s+/i.exec(value)?.[1];
        out[key] = scheme !== undefined ? `${scheme} <REDACTED:${key}>` : `<REDACTED:${key}>`;
      } else out[key] = this.text(value);
    }
    return out;
  }

  /** A body string: JSON is redacted structurally (credential fields by name) and then textually. */
  body(input: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return this.text(input);
    }
    return this.text(JSON.stringify(this.json(parsed)));
  }

  json(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = CREDENTIAL_FIELDS.has(k) && typeof v === "string" ? `<REDACTED:${k}>` : this.json(v);
      }
      return out;
    }
    return typeof value === "string" ? this.text(value) : value;
  }

  /** Every surviving secret label or token prefix in `output`; an empty list means the output may be written. */
  scan(output: string): string[] {
    const hits: string[] = [];
    for (const s of this.secrets) if (output.includes(s.value)) hits.push(`secret:${s.label}`);
    for (const prefix of TOKEN_PREFIXES) if (output.includes(prefix)) hits.push(`prefix:${prefix}`);
    return hits;
  }
}
