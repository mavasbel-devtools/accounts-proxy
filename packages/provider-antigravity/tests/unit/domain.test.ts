import { describe, expect, test } from "bun:test";
import { QuotaExhaustedError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import { accountId, activeProject, fromCredential, rotated, toCredential, type AntigravityAccount } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import { advertisedLimits, descriptorDetails, toModelDescriptors, type ModelDescriptor } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import { onboardedProjectId } from "@accounts-proxy/provider-antigravity/domain/project.ts";
import { formatUsage } from "@accounts-proxy/provider-antigravity/domain/quota.ts";
import { defaultFamilyOf, isContinuation, isSessionId } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";
import { asResponseEnvelope, isLocationGate, isUnauthorized, outerEnvelope, retryAfterSeconds, upstreamFailure } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";

const account: AntigravityAccount = { email: "me@x", tokens: { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000 }, projectIds: ["p1", "p2"], activeProjectId: "p2" };

describe("account", () => {
  test("credential round trip, labels and ids", () => {
    const credential = toCredential(account, "me@x");
    expect(credential).toMatchObject({ provider: "antigravity", id: "me@x", label: "me@x" });
    expect(fromCredential(credential)).toEqual(account);
    const bare: AntigravityAccount = { email: "", tokens: { accessToken: "a", expiresAt: 1 }, projectIds: [] };
    const minted = toCredential(bare, accountId(bare, () => "u-1"));
    expect(minted.id).toBe("antigravity-u-1");
    expect(minted.label).toBe("antigravity-u-1");
    expect(fromCredential(minted)).toEqual(bare);
    expect(accountId(account, () => "never")).toBe("me@x");
  });
  test.each([
    [{}],
    [{ email: "e", tokens: null, projectIds: [] }],
    [{ email: "e", tokens: [], projectIds: [] }],
    [{ email: "e", tokens: { accessToken: 1, expiresAt: 1 }, projectIds: [] }],
    [{ email: "e", tokens: { accessToken: "a", expiresAt: "1" }, projectIds: [] }],
    [{ email: "e", tokens: { accessToken: "a", expiresAt: 1 }, projectIds: "p" }],
    [{ email: "e", tokens: { accessToken: "a", expiresAt: 1 }, projectIds: [1] }],
  ])("fromCredential rejects %p", (data) => {
    expect(fromCredential({ provider: "antigravity", id: "x", label: "x", data: data as never })).toBeUndefined();
  });
  test("active project, rotation keeps the refresh token", () => {
    expect(activeProject(account)).toBe("p2");
    expect(activeProject({ ...account, activeProjectId: undefined } as never)).toBe("p1");
    expect(rotated(account.tokens, { accessToken: "b", expiresAt: 9 })).toEqual({ accessToken: "b", refreshToken: "r", expiresAt: 9 });
    expect(rotated(account.tokens, { accessToken: "b", refreshToken: "r2", expiresAt: 9 })).toEqual({ accessToken: "b", refreshToken: "r2", expiresAt: 9 });
    expect(rotated({ accessToken: "a", expiresAt: 1 }, { accessToken: "b", expiresAt: 9 })).toEqual({ accessToken: "b", expiresAt: 9 });
  });
});

describe("catalog helpers", () => {
  const d: ModelDescriptor = { wireId: "w", displayName: "W", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsImages: false, supportsThinking: true, supportsVideo: false, thinkingBudget: 1000, recommended: false, enumPlaceholder: "MODEL_W" };
  test("limits only when both are positive; the catalog windows verbatim (plan 2026-11-02-21-29)", () => {
    expect(advertisedLimits(d)).toEqual({ context: 1_048_576, output: 65_536 });
    expect(advertisedLimits({ ...d, maxOutputTokens: 0 })).toBeUndefined();
    expect(advertisedLimits({ ...d, maxTokens: 0 })).toBeUndefined();
    expect(advertisedLimits({ ...d, maxTokens: 16_384 })).toEqual({ context: 16_384, output: 65_536 });
  });
});

describe("project", () => {
  test.each([
    [{ response: { cloudaicompanionProject: { id: "p" } } }, "p"],
    [{ response: { cloudaicompanionProject: { id: 7 } } }, ""],
    [{ response: { cloudaicompanionProject: "p" } }, ""],
    [{ response: null }, ""],
    [{}, ""],
  ])("onboardedProjectId(%p) = %p", (raw, id) => {
    expect(onboardedProjectId(raw)).toBe(id);
  });
});

describe("quota", () => {
  test("a prototype-named window is not a label (own-property lookup)", () => {
    const view = formatUsage({ capturedAt: 1, groups: [{ displayName: "G", buckets: [{ bucketId: "b", displayName: "", window: "toString", resetTime: "t", remainingFraction: 0.5 }] }] });
    expect(view.groups[0]!.buckets[0]!.window).toBe("toString");
  });
});

describe("trajectory helpers", () => {
  test.each([
    ["0", true],
    ["-9223372036854775808", true],
    ["9223372036854775807", true],
    ["9223372036854775808", false],
    ["-9223372036854775809", false],
    ["01", false],
    ["1.5", false],
    ["", false],
    [12, false],
  ])("isSessionId(%p) = %p", (value, expected) => {
    expect(isSessionId(value)).toBe(expected);
  });
  test("family and continuation", () => {
    expect(defaultFamilyOf("Gemini-3")).toBe("gemini");
    expect(defaultFamilyOf("claude-x")).toBe("claude");
    expect(defaultFamilyOf("gpt-oss")).toBe("other");
    expect(isContinuation("b|1", [{ role: "user", text: "a" }])).toBe(false);
    expect(isContinuation("a|x", [{ role: "user", text: "a" }])).toBe(true);
  });
});

describe("upstream", () => {
  test("outer envelope key order", () => {
    expect(Object.keys(outerEnvelope({ project: "p", requestId: "r", body: {}, modelWireId: "m" }))).toEqual(["project", "requestId", "request", "model", "userAgent", "requestType"]);
  });
  test("non-response payloads", () => {
    const env = { response: {} };
    expect(asResponseEnvelope(env)).toBe(env);
    const bare = { candidates: [] };
    expect(asResponseEnvelope(bare)).toBe(bare as never);
    expect(() => asResponseEnvelope({ error: { code: 429 } })).toThrow("non-response payload");
    expect(() => asResponseEnvelope(5)).toThrow("non-object payload: 5");
    expect(() => asResponseEnvelope(null)).toThrow(UpstreamError);
  });
  test("retry-after delta-seconds only", () => {
    expect(retryAfterSeconds(" 30 ")).toBe(30);
    expect(retryAfterSeconds(undefined)).toBeUndefined();
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });
  test("failure classification", () => {
    const quota = upstreamFailure(429, "RESOURCE_EXHAUSTED", "12");
    expect(quota).toBeInstanceOf(QuotaExhaustedError);
    expect(quota.retryAfterSeconds).toBe(12);
    const other = upstreamFailure(503, "x".repeat(900), undefined);
    expect(other).toBeInstanceOf(UpstreamError);
    expect((other as UpstreamError).body).toHaveLength(500);
    expect(isLocationGate(upstreamFailure(400, '{"error":{"message":"User location is not supported for the API use."}}', undefined))).toBe(true);
    expect(isLocationGate(upstreamFailure(400, "bad request", undefined))).toBe(false);
    expect(isLocationGate(upstreamFailure(403, "User location is not supported", undefined))).toBe(false);
    expect(isLocationGate(new Error("User location is not supported"))).toBe(false);
    expect(isUnauthorized(upstreamFailure(401, "", undefined))).toBe(true);
    expect(isUnauthorized(upstreamFailure(403, "", undefined))).toBe(false);
  });
});

describe("descriptorDetails (plan 2026-10-16 C3)", () => {
  test("media from the flags and the MIME types; reasoning from supportsThinking; toolCall true for chat models", () => {
    const d: ModelDescriptor = { wireId: "m", displayName: "M", maxTokens: 1, maxOutputTokens: 1, supportsImages: false, supportsThinking: false, supportsVideo: false, recommended: false, enumPlaceholder: "" };
    expect(descriptorDetails(d)).toEqual({ input: ["text"], reasoning: false, toolCall: true });
    expect(descriptorDetails({ ...d, supportsThinking: true, mimeTypes: ["image/png", "audio/mp3", "video/mp4", "application/pdf", "text/csv"] })).toEqual({ input: ["text", "image", "audio", "video", "pdf"], reasoning: true, toolCall: true });
    expect(descriptorDetails({ ...d, supportsImages: true, supportsVideo: true }).input).toEqual(["text", "image", "video"]);
    expect(descriptorDetails({ ...d, wireId: "gemini-3.1-flash-image" }).toolCall).toBe(false);
    expect(descriptorDetails({ ...d, wireId: "tab_jump_flash_lite" }).toolCall).toBe(false);
    expect(descriptorDetails({ ...d, wireId: "chat_20706" }).toolCall).toBe(false);
    expect(toModelDescriptors({ models: { a: { supportedMimeTypes: { "image/png": true, "audio/wav": false } }, b: { supportedMimeTypes: { "x/y": false } } } }).map((m) => m.mimeTypes)).toEqual([["image/png"], undefined]);
  });
});
