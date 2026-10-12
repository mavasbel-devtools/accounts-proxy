// S12: RS256 signature of the ID token against OpenAI's published JWKS (RFC 7517), verified with node:crypto (no JOSE
// library: the plan keeps the dependency set unchanged), then the claim checks of domain/id-token.ts. The key set is
// fetched once per process and fetched again once when the token's `kid` is not in it (key rotation).
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";
import { ProviderAuthRequiredError, UpstreamError } from "@inference-router/core/domain/errors.ts";
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import type { ClockPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import { CATALOG, USER_AGENT } from "@inference-router/provider-openai/domain/constants.ts";
import { checkClaims, IdTokenError, parseCompactJws, type ExpectedClaims, type VerifiedIdentity } from "@inference-router/provider-openai/domain/id-token.ts";
import { IdTokenVerifierPort } from "@inference-router/provider-openai/ports/outbound/openai.ts";

type Jwk = JsonWebKeyInput["key"] & { readonly kid?: string; readonly kty?: string; readonly use?: string };

export class JwksIdTokenVerifier extends IdTokenVerifierPort {
  private keys: readonly Jwk[] | undefined;

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
      const key = (await this.key(kid, false)) ?? (await this.key(kid, true));
      if (key === undefined) throw new IdTokenError(`no RSA key ${kid ?? "(no kid)"} in the published key set`);
      if (!verify("RSA-SHA256", new TextEncoder().encode(jws.signingInput), key, jws.signature)) throw new IdTokenError("the signature does not verify");
      return checkClaims(jws.claims, { ...expected, now: this.clock.now() });
    } catch (error) {
      if (error instanceof IdTokenError) throw new ProviderAuthRequiredError("openai", `ChatGPT sign-in returned an ${error.message}`);
      throw error;
    }
  }

  private async key(kid: string | undefined, refetch: boolean): Promise<KeyObject | undefined> {
    if (refetch || this.keys === undefined) this.keys = await this.fetchKeys();
    const rsa = this.keys.filter((k) => k.kty === "RSA" && (k.use === undefined || k.use === "sig"));
    const jwk = kid === undefined ? (rsa.length === 1 ? rsa[0] : undefined) : rsa.find((k) => k.kid === kid);
    return jwk === undefined ? undefined : createPublicKey({ key: jwk, format: "jwk" });
  }

  private async fetchKeys(): Promise<readonly Jwk[]> {
    const res = await this.transport.send({ method: "GET", url: this.jwksUrl, headers: { accept: "application/json", "user-agent": USER_AGENT }, timeoutMs: CATALOG.timeoutMs });
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
