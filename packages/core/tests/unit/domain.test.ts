import { describe, expect, test } from "bun:test";
import { activeAccount, EMPTY_POOL, markNeedsLogin, replaceAccount, TOKEN_ENDPOINT_TIMEOUT_MS, upsertAccount, useAccount, type AccountCredential } from "@inference-router/core/domain/accounts.ts";
import {
  ClientRequestError,
  InvalidRequestError,
  ProviderAuthRequiredError,
  ProviderDisabledError,
  ProviderError,
  QuotaExhaustedError,
  RouterError,
  UnauthorizedError,
  UnknownAccountError,
  UnknownModelError,
  UnsupportedFeatureError,
  UpstreamError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
  isTransientUpstream,
  asRouterError,
  InternalError,
} from "@inference-router/core/domain/errors.ts";
import { isJsonObject } from "@inference-router/core/domain/json.ts";
import { formatModelAddress, isProviderId, modelFormats, PROVIDER_IDS, SUBSCRIPTION_PROVIDERS } from "@inference-router/core/domain/models.ts";
import { base64UrlDecode, base64UrlEncode } from "@inference-router/core/domain/services/base64url.ts";
import { resolveModelAddress } from "@inference-router/core/domain/services/model-address.ts";
import { bodyOf, readAll } from "@inference-router/core/domain/wire.ts";

describe("json", () => {
  test("isJsonObject accepts plain objects only", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });
});

describe("models", () => {
  test("provider ids", () => {
    expect(PROVIDER_IDS).toEqual(["claude", "antigravity", "openai", "openrouter", "opencode", "opencode-go", "cheaper-inference"]);
    expect(SUBSCRIPTION_PROVIDERS).toEqual(["claude", "antigravity", "openai"]);
    expect(isProviderId("antigravity")).toBe(true);
    expect(isProviderId("cheaper")).toBe(false);
  });
  test("modelFormats: the model's own formats, else the catalog's", () => {
    const catalog = { provider: "opencode" as const, formats: [], source: "live" as const, models: [] };
    expect(modelFormats(catalog, { address: { provider: "opencode", model: "a" }, displayName: "A", formats: ["gemini"] })).toEqual(["gemini"]);
    expect(modelFormats({ ...catalog, formats: ["openai-chat"] }, { address: { provider: "opencode", model: "b" }, displayName: "B" })).toEqual(["openai-chat"]);
  });
  test("formatModelAddress", () => {
    expect(formatModelAddress({ provider: "antigravity", model: "gemini-3-pro" })).toBe("antigravity/gemini-3-pro");
  });
});

describe("resolveModelAddress", () => {
  const aliases = { opus: "claude/claude-opus-4-8", broken: "nope", bad: "cheaper/x" };
  test("splits on the first slash and keeps further slashes in the model", () => {
    expect(resolveModelAddress("antigravity/a/b", {})).toEqual({ provider: "antigravity", model: "a/b" });
  });
  test("resolves an alias", () => {
    expect(resolveModelAddress("opus", aliases)).toEqual({ provider: "claude", model: "claude-opus-4-8" });
  });
  test.each([["gpt-4o"], ["broken"], ["bad"], ["cheaper/x"], ["/model"], ["antigravity/"], ["antigravity/   "], ["toString"]])(
    "rejects %p",
    (input) => {
      expect(() => resolveModelAddress(input, aliases)).toThrow(UnknownModelError);
    },
  );
});

describe("errors", () => {
  test("tree, codes and statuses", () => {
    const cases: [RouterError, string, number, typeof ClientRequestError | typeof ProviderError][] = [
      [new InvalidRequestError("bad"), "invalid_request", 400, ClientRequestError],
      [new UnsupportedFeatureError(["images", "top_k"], "antigravity"), "unsupported_feature", 400, ClientRequestError],
      [new UnauthorizedError(), "unauthorized", 401, ClientRequestError],
      [new UnknownModelError("x"), "unknown_model", 404, ClientRequestError],
      [new UnknownAccountError("antigravity", "a@b"), "unknown_account", 404, ClientRequestError],
      [new ProviderAuthRequiredError("antigravity", "no account"), "provider_auth_required", 401, ProviderError],
      [new ProviderDisabledError("claude"), "provider_disabled", 503, ProviderError],
      [new QuotaExhaustedError("antigravity", "5h window", 30), "quota_exhausted", 429, ProviderError],
      [new UpstreamError("claude", 529, "overloaded", 5), "upstream_error", 529, ProviderError],
      [new UpstreamUnreachableError("api.anthropic.com", "Unable to connect"), "upstream_unreachable", 502, ProviderError],
    ];
    for (const [error, code, status, family] of cases) {
      expect(error).toBeInstanceOf(RouterError);
      expect(error).toBeInstanceOf(family);
      expect(error.code).toBe(code as RouterError["code"]);
      expect(error.httpStatus).toBe(status);
      expect(error.name).toBe(error.constructor.name);
    }
  });
  test("messages and retry hints", () => {
    expect(new UnsupportedFeatureError(["images", "top_k"], "antigravity").message).toBe("antigravity cannot carry: images, top_k");
    expect(new ProviderAuthRequiredError("antigravity", "no account").message).toContain("inference-router login antigravity");
    expect(new ProviderDisabledError("claude").message).toBe("claude is disabled; enable it with acknowledgeTermsRisk: true in router.yaml");
    expect(new ProviderDisabledError("openrouter").message).toBe("openrouter is disabled; enable it with enabled: true in router.yaml");
    expect(new QuotaExhaustedError("antigravity", "x", 30).retryAfterSeconds).toBe(30);
    expect(new QuotaExhaustedError("antigravity", "x").retryAfterSeconds).toBeUndefined();
    expect(new UpstreamError("antigravity", 500, "e".repeat(600)).message.length).toBeLessThan(560);
    expect(new UpstreamError("antigravity", 500, "e").retryAfterSeconds).toBeUndefined();
    expect(new InvalidRequestError("bad").retryAfterSeconds).toBeUndefined();
    expect(new UpstreamUnreachableError("h:1", "refused").message).toBe("upstream h:1 could not be reached: refused");
    expect(new ProviderAuthRequiredError("claude", "why").detail).toBe("why");
  });
  test("asRouterError keeps a RouterError and turns anything else into the fixed InternalError", () => {
    const quota = new QuotaExhaustedError("claude", "x");
    expect(asRouterError(quota)).toBe(quota);
    expect(asRouterError(new Error("defect"))).toBeInstanceOf(InternalError);
  });
  test("transient upstream failures (plan v4 H4)", () => {
    expect(isTransientUpstream(new UpstreamTimeoutError("h", 1))).toBe(true);
    expect(isTransientUpstream(new UpstreamUnreachableError("h", "x"))).toBe(true);
    expect(isTransientUpstream(new UpstreamError("claude", 500, "x"))).toBe(true);
    expect(isTransientUpstream(new UpstreamError("claude", 499, "x"))).toBe(false);
    expect(isTransientUpstream(new QuotaExhaustedError("claude", "x"))).toBe(false);
    expect(isTransientUpstream(new Error("x"))).toBe(false);
  });
});

describe("accounts", () => {
  const a: AccountCredential = { provider: "antigravity", id: "a@x", label: "a@x", data: { t: 1 } };
  const b: AccountCredential = { provider: "antigravity", id: "b@x", label: "b@x", data: { t: 2 } };
  test("upsert makes the account active and replaces by id", () => {
    const pool = upsertAccount(upsertAccount(EMPTY_POOL, a), b);
    expect(pool.activeId).toBe("b@x");
    const again = upsertAccount(pool, { ...a, data: { t: 3 } });
    expect(again.accounts.map((x) => x.id)).toEqual(["b@x", "a@x"]);
    expect(activeAccount(again)?.data).toEqual({ t: 3 });
  });
  test("use selects a known account and rejects unknown ones", () => {
    const pool = upsertAccount(upsertAccount(EMPTY_POOL, a), b);
    expect(useAccount(pool, "antigravity", "a@x").activeId).toBe("a@x");
    expect(() => useAccount(pool, "antigravity", "zz")).toThrow(UnknownAccountError);
  });
  test("activeAccount is undefined for an empty pool; replace keeps order and active", () => {
    expect(activeAccount(EMPTY_POOL)).toBeUndefined();
    const pool = upsertAccount(upsertAccount(EMPTY_POOL, a), b);
    const replaced = replaceAccount(pool, { ...a, data: { t: 9 } });
    expect(replaced.accounts[0]!.data).toEqual({ t: 9 });
    expect(replaced.activeId).toBe("b@x");
  });
  test("markNeedsLogin marks one account; a login clears it", () => {
    const pool = upsertAccount(upsertAccount(EMPTY_POOL, a), b);
    const marked = markNeedsLogin(pool, a, "grant rejected");
    expect(marked.accounts[0]!.needsLogin).toBe("grant rejected");
    expect(marked.accounts[1]!.needsLogin).toBeUndefined();
    expect(upsertAccount(marked, a).accounts.find((x) => x.id === "a@x")!.needsLogin).toBeUndefined();
    expect(TOKEN_ENDPOINT_TIMEOUT_MS).toBe(30_000);
  });
});

describe("base64url (RFC 4648 §10 test vectors, unpadded, url alphabet)", () => {
  const enc = (s: string) => base64UrlEncode(new TextEncoder().encode(s));
  test.each([
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ])("%p -> %p", (input, output) => {
    expect(enc(input)).toBe(output);
    expect(new TextDecoder().decode(base64UrlDecode(output))).toBe(input);
  });
  test("decoding accepts padding and rejects foreign characters and impossible lengths", () => {
    expect(new TextDecoder().decode(base64UrlDecode("Zm9vYg=="))).toBe("foob");
    expect(base64UrlDecode("-_-_")).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
    expect(base64UrlDecode("Zm+v")).toBeUndefined();
    expect(base64UrlDecode("Zm9vY")).toBeUndefined();
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });
  test("uses - and _ instead of + and /", () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });
  test("RFC 7636 appendix B challenge from the known SHA-256 digest", () => {
    const digest = new Uint8Array([
      19, 211, 30, 150, 26, 26, 216, 236, 47, 22, 177, 12, 76, 152, 46, 8, 118, 168, 120, 173, 109, 241, 68, 86, 110, 225, 137, 74, 203,
      112, 249, 195,
    ]);
    expect(base64UrlEncode(digest)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("wire bodies", () => {
  test("readAll decodes UTF-8 split across chunks; bodyOf yields one chunk", async () => {
    const bytes = new TextEncoder().encode("añ€");
    async function* split() {
      yield bytes.slice(0, 2);
      yield bytes.slice(2, 4);
      yield bytes.slice(4);
    }
    expect(await readAll(split())).toBe("añ€");
    const chunks: Uint8Array[] = [];
    for await (const c of bodyOf("añ€")) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(await readAll(bodyOf("añ€"))).toBe("añ€");
  });
});
