// S12: RS256 signature of the ID token against OpenAI's published JWKS (RFC 7517), verified with node:crypto (no JOSE
// library: the plan keeps the dependency set unchanged), then the claim checks of domain/id-token.ts. The key set is
// fetched for each verification (one per sign-in) and fetched again once when the token's `kid` is not in it (key
// rotation).
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";
import { ProviderAuthRequiredError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { ClockPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import { JWKS_TIMEOUT_MS, USER_AGENT } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { checkClaims, IdTokenError, parseCompactJws, type ExpectedClaims, type VerifiedIdentity } from "@accounts-proxy/provider-openai/domain/id-token.ts";
import { IdTokenVerifierPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";

type Jwk = JsonWebKeyInput["key"] & { readonly kid?: string; readonly kty?: string; readonly use?: string };

export class JwksIdTokenVerifier extends IdTokenVerifierPort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly clock: ClockPort,
    private readonly jwksUrl: string,
  ) {
    super();
  }

  async verify(idToken: string, expected: ExpectedClaims): Promise<VerifiedIdentity> {
    try {
      const jws = parseCompactJws(idToken);
      const kid = typeof jws.header["kid"] === "string" ? jws.header["kid"] : undefined;
      const key = (await this.key(kid)) ?? (await this.key(kid));
      if (key === undefined) throw new IdTokenError(`no RSA key ${kid ?? "(no kid)"} in the published key set`);
      if (!verify("RSA-SHA256", new TextEncoder().encode(jws.signingInput), key, jws.signature)) throw new IdTokenError("the signature does not verify");
      return checkClaims(jws.claims, { ...expected, now: this.clock.now() });
    } catch (error) {
      if (error instanceof IdTokenError) throw new ProviderAuthRequiredError("openai", `ChatGPT sign-in returned an ${error.message}`);
      throw error;
    }
  }

  private async key(kid: string | undefined): Promise<KeyObject | undefined> {
    const rsa = (await this.fetchKeys()).filter((k) => k.kty === "RSA" && (k.use === undefined || k.use === "sig"));
    const jwk = kid === undefined ? (rsa.length === 1 ? rsa[0] : undefined) : rsa.find((k) => k.kid === kid);
    return jwk === undefined ? undefined : createPublicKey({ key: jwk, format: "jwk" });
  }

  private async fetchKeys(): Promise<readonly Jwk[]> {
    const res = await this.transport.send({ method: "GET", url: this.jwksUrl, headers: { accept: "application/json", "user-agent": USER_AGENT }, timeoutMs: JWKS_TIMEOUT_MS });
    const text = await readAll(res.body);
    if (res.status !== 200) throw new UpstreamError("openai", res.status, `JWKS: ${text}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isJsonObject(parsed) || !Array.isArray(parsed["keys"])) throw new UpstreamError("openai", 502, `JWKS is not a key set: ${text}`);
    return parsed["keys"].filter(isJsonObject) as Jwk[];
  }
}
