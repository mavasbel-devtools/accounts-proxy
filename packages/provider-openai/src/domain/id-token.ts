// ID-token rules S12–S13 (openai-siwc-sign-in.md §4; chatgpt.ts:456-476 verifies the same claims with `jose`):
// an RS256 JWS (RFC 7515 compact form) whose signature verifies against OpenAI's published JWKS, with
// iss = https://auth.openai.com, aud ∋ the issued client id, exp in the future, nonce = this attempt's, a non-empty sub.
// This module is the pure part: the compact form, the header and the claims. The signature is checked by the
// IdTokenVerifierPort adapter.
import { isJsonObject, type JsonObject } from "@accounts-proxy/core/domain/json.ts";
import { base64UrlDecode } from "@accounts-proxy/core/domain/services/base64url.ts";
import { ISSUER } from "@accounts-proxy/provider-openai/domain/constants.ts";

export type CompactJws = {
  readonly header: JsonObject;
  readonly claims: JsonObject;
  /** The ASCII `<header>.<payload>` the signature covers (RFC 7515 §5.2). */
  readonly signingInput: string;
  readonly signature: Uint8Array;
};

export class IdTokenError extends Error {
  constructor(reason: string) {
    super(`invalid ID token: ${reason}`);
    this.name = "IdTokenError";
  }
}

function json(segment: string, what: string): JsonObject {
  const bytes = base64UrlDecode(segment);
  let value: unknown;
  try {
    value = bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    value = undefined;
  }
  if (!isJsonObject(value)) throw new IdTokenError(`the ${what} is not a base64url JSON object`);
  return value;
}

export function parseCompactJws(token: string): CompactJws {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdTokenError("not a compact JWS (three dot-separated parts)");
  const [head, payload, sig] = parts as [string, string, string];
  const header = json(head, "header");
  const claims = json(payload, "payload");
  const signature = base64UrlDecode(sig);
  if (signature === undefined || signature.length === 0) throw new IdTokenError("the signature is not base64url");
  if (header["alg"] !== "RS256") throw new IdTokenError(`algorithm ${JSON.stringify(header["alg"])} is not RS256`);
  return { header, claims, signingInput: `${head}.${payload}`, signature };
}

export type ExpectedClaims = { readonly clientId: string; readonly nonce: string; readonly now: number };
export type VerifiedIdentity = { readonly subject: string; readonly email?: string };

/** The claim checks of S12; returns the verified identity (S13). */
export function checkClaims(claims: JsonObject, expected: ExpectedClaims): VerifiedIdentity {
  if (claims["iss"] !== ISSUER) throw new IdTokenError(`issuer ${JSON.stringify(claims["iss"])} is not ${ISSUER}`);
  const aud = claims["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expected.clientId)) throw new IdTokenError("the audience is not this client");
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp * 1000 <= expected.now) throw new IdTokenError("expired or without exp");
  if (claims["nonce"] !== expected.nonce) throw new IdTokenError("the nonce does not match this sign-in attempt");
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.trim() === "") throw new IdTokenError("the subject is missing");
  const email = claims["email"];
  return { subject: sub, ...(typeof email === "string" && email !== "" ? { email } : {}) };
}
