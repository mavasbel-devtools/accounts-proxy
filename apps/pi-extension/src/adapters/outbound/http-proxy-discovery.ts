// The proxy's HTTP surface as the extension sees it (architecture design §5): the well-known manifest
// and the token-protected document, each with a 5000 ms deadline. The fetch function is injected (the
// global one in composition); a non-2xx answer names the status and the proxy's error.message.
import type { JsonObject, PiManifest } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";
import { ProxyDiscoveryPort } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";

/** The slice of fetch the discovery uses. globalThis.fetch satisfies it. */
export type FetchFn = (
  url: string,
  init: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; readonly statusText: string; json(): Promise<unknown> }>;

type ErrorBody = { readonly error?: { readonly message?: unknown } } | undefined | null;

export class HttpProxyDiscovery extends ProxyDiscoveryPort {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly baseUrl: string,
  ) {
    super();
  }

  async manifest(): Promise<PiManifest> {
    const doc = await this.get(`${this.baseUrl}/.well-known/pi`);
    return doc as unknown as PiManifest;
  }

  async config(url: string, token: string): Promise<JsonObject> {
    return this.get(url, token);
  }

  private async get(url: string, token?: string): Promise<JsonObject> {
    const response = await this.fetchFn(url, {
      ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await this.errorMessage(response)}`);
    return (await response.json()) as JsonObject;
  }

  private async errorMessage(response: { readonly statusText: string; json(): Promise<unknown> }): Promise<string> {
    try {
      const message = ((await response.json()) as ErrorBody)?.error?.message;
      return typeof message === "string" ? message : response.statusText;
    } catch {
      return response.statusText;
    }
  }
}
