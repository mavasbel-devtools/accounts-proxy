// Test signer for OpenAI ID tokens: a fresh RSA key per instance, its JWKS (RFC 7517) and RS256 compact JWS (RFC 7515)
// tokens, so tests can drive the real verifier (signature and claims) without OpenAI's keys.
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

export class IdTokenSigner {
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(kid = "e2e-key") {
    this.kid = kid;
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  /** The key set `GET /.well-known/jwks.json` answers. */
  jwks(extra: readonly Record<string, unknown>[] = []): { keys: Record<string, unknown>[] } {
    return { keys: [...extra, { ...this.publicKey.export({ format: "jwk" }), kid: this.kid, use: "sig", alg: "RS256" }] };
  }

  /** An RS256 compact JWS over `claims`; `header` overrides the protected header. */
  sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.kid, ...header }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(input).sign(this.privateKey);
    return `${input}.${b64url(signature)}`;
  }

  /** The claims of a valid sign-in for `clientId` / `nonce` at epoch-ms `now`. */
  static claims(clientId: string, nonce: string, now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { iss: "https://auth.openai.com", aud: [clientId], sub: "user-e2e-subject", email: "e2e@example.com", nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...extra };
  }
}
