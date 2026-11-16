// Unit tests for HttpProxyDiscovery (uc-pi-4): injected fetch, no I/O.
import { describe, expect, test } from "bun:test";
import type { FetchFn } from "@accounts-proxy/pi-extension/adapters/outbound/http-proxy-discovery.ts";
import { HttpProxyDiscovery } from "@accounts-proxy/pi-extension/adapters/outbound/http-proxy-discovery.ts";

const BASE = "http://127.0.0.1:4141";
const MANIFEST = { auth: { command: ["token"], env: "ACCOUNTS_PROXY_TOKEN" }, config: { url: `${BASE}/pi/models.json` } };

type Call = { readonly url: string; readonly headers: Record<string, string> | undefined; readonly signal: unknown };

function setup(respond: (url: string) => { ok: boolean; status: number; statusText: string; body: () => Promise<unknown> }) {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    const res = respond(url);
    return { ok: res.ok, status: res.status, statusText: res.statusText, json: res.body };
  };
  return { discovery: new HttpProxyDiscovery(fetchFn, BASE), calls };
}

const ok = (doc: unknown) => () => ({ ok: true, status: 200, statusText: "OK", body: async () => doc });
const failed = (status: number, statusText: string, body: () => Promise<unknown>) => () => ({ ok: false, status, statusText, body });

describe("HttpProxyDiscovery", () => {
  test("GETs the well-known manifest without an auth header on a signaling request [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const { discovery, calls } = setup(ok(MANIFEST));
    await expect(discovery.manifest()).resolves.toEqual(MANIFEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/.well-known/pi`);
    expect(calls[0]!.headers).toBeUndefined();
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("GETs the document with the Bearer token [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const doc = { providers: {} };
    const { discovery, calls } = setup(ok(doc));
    await expect(discovery.config(`${BASE}/pi/models.json`, "secret")).resolves.toEqual(doc);
    expect(calls[0]!.headers).toEqual({ authorization: "Bearer secret" });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("a non-2xx answer names the status and the proxy error message [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery } = setup(failed(401, "Unauthorized", async () => ({ error: { code: "unauthorized", message: "bad token" } })));
    await expect(discovery.manifest()).rejects.toThrow(`${BASE}/.well-known/pi answered 401: bad token`);
  });

  test("a non-2xx answer without an error message falls back to the status text [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery } = setup(failed(503, "Service Unavailable", async () => ({})));
    await expect(discovery.manifest()).rejects.toThrow(`${BASE}/.well-known/pi answered 503: Service Unavailable`);
  });

  test("a non-2xx answer with a non-object body falls back to the status text [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery } = setup(failed(502, "Bad Gateway", async () => null));
    await expect(discovery.manifest()).rejects.toThrow(`${BASE}/.well-known/pi answered 502: Bad Gateway`);
  });

  test("a non-2xx answer with a non-JSON body falls back to the status text [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { discovery } = setup(
      failed(500, "Internal Server Error", async () => {
        throw new SyntaxError("Unexpected token <");
      }),
    );
    await expect(discovery.manifest()).rejects.toThrow(`${BASE}/.well-known/pi answered 500: Internal Server Error`);
  });

  test("a fetch failure rejects [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const calls: Call[] = [];
    const discovery = new HttpProxyDiscovery(async () => {
      throw new Error("connection refused");
    }, BASE);
    await expect(discovery.manifest()).rejects.toThrow("connection refused");
    expect(calls).toEqual([]);
  });
});
