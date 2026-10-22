import { parseReference, type ReferenceModel } from "@accounts-proxy/core/domain/model-details.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GO_BUILTIN, ZEN_BUILTIN } from "@accounts-proxy/provider-opencode/domain/builtin-models.ts";
import { UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import {
  consoleIdentity,
  decodeCredential,
  encodeDevice,
  GO_SPEC,
  isInvalidGrant,
  opencodeModels,
  referenceFormats,
  parseDeviceAuthorization,
  parseTokens,
  pollError,
  workspaceHeaders,
  ZEN_SPEC,
} from "@accounts-proxy/provider-opencode/domain/opencode.ts";

const spec = (file: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", file), "utf8"));

describe("OpenCode Zen and Go rules", () => {
  test("Z12–Z15, Z9, Z26: Console addresses, bearer everywhere, the client's User-Agent (else the proxy's) and x-opencode-session; Go has no Gemini route", () => {
    expect([ZEN_SPEC.apiBase, GO_SPEC.apiBase]).toEqual(["https://opencode.ai/inference", "https://opencode.ai/inference/go"]);
    expect(ZEN_SPEC.endpoints).toEqual({
      "openai-chat": { path: "/openai/v1/chat/completions" },
      "openai-responses": { path: "/openai/v1/responses" },
      "anthropic-messages": { path: "/anthropic/v1/messages" },
      gemini: { path: "/google/v1beta/models" },
    });
    expect(GO_SPEC.endpoints).toEqual({
      "openai-chat": { path: "/v1/chat/completions" },
      "openai-responses": { path: "/v1/responses" },
      "anthropic-messages": { path: "/v1/messages" },
    });
    for (const spec of [ZEN_SPEC, GO_SPEC]) {
      expect([spec.requestIdHeader, spec.uniformFormats, spec.headers, spec.forwardHeaders]).toEqual(["x-opencode-log-id", undefined, { "user-agent": "accounts-proxy/0.1.0" }, ["x-opencode-session", "user-agent"]]);
    }
  });

  test("the User-Agent names the proxy's own version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "apps", "proxy", "package.json"), "utf8")) as { name: string; version: string };
    expect(ZEN_SPEC.headers!["user-agent"]).toBe(`accounts-proxy/${pkg.version}`);
  });

  test("Z4 + Z5: the committed lists and the reference catalog give the built-in lists", () => {
    const reference = parseReference(spec("models-opencode-reference.json"));
    const zen = opencodeModels(spec("opencode-zen-models.json"), referenceFormats(reference, "opencode"));
    const go = opencodeModels(spec("opencode-go-models.json"), referenceFormats(reference, "opencode-go"));
    expect(zen).toEqual([...ZEN_BUILTIN]);
    expect(go).toEqual([...GO_BUILTIN]);
    expect(zen.find((m) => m.id === "big-pickle")).toEqual({ id: "big-pickle", displayName: "big-pickle", formats: ["openai-chat"] });
    // zen.mdx: Claude models on /messages, GPT on /responses, Gemini on /models/<id>, Mistral on /chat/completions.
    const format = (id: string) => zen.find((m) => m.id === id)?.formats;
    expect([format("claude-haiku-4-5"), format("gpt-5.5"), format("gemini-3.6-flash"), format("mistral-large-4")]).toEqual([["anthropic-messages"], ["openai-responses"], ["gemini"], ["openai-chat"]]);
    // Z6: a live id that the reference does not describe keeps no formats.
    expect(zen.find((m) => m.id === "jev-1.13")).toEqual({ id: "jev-1.13", displayName: "jev-1.13" });
  });

  test("referenceFormats: the AI SDK package of each model, unknown packages and models without one left out", () => {
    const reference = new Map([["opencode", new Map<string, ReferenceModel>([["a", { aiSdkPackage: "@ai-sdk/mistral" }], ["b", { aiSdkPackage: "@ai-sdk/unknown" }], ["c", {}]])]]);
    expect([...referenceFormats(reference, "opencode")]).toEqual([["a", "openai-chat"]]);
    expect(referenceFormats(reference, "opencode-go").size).toBe(0);
    expect(opencodeModels({ data: [{ id: "x" }, { object: "model" }, "y"] }, new Map())).toEqual([{ id: "x", displayName: "x" }]);
    expect(opencodeModels(null, new Map())).toEqual([]);
  });

});

describe("OpenCode Console device login and workspace config (Z17–Z20)", () => {
  test("Z17: the device-code answer (the live field set); the page resolved against the Console URL; incomplete or non-HTTP answers refused", () => {
    const answer = { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "/console/device", verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=accounts-proxy", expires_in: 600, interval: 5 };
    expect(parseDeviceAuthorization(answer, "https://opencode.ai/console")).toEqual({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=accounts-proxy",
      intervalMs: 5000,
      expiresInMs: 600_000,
    });
    for (const broken of [{ ...answer, interval: 0 }, { ...answer, verification_uri_complete: undefined }, { ...answer, user_code: 7 }, { ...answer, device_code: "" }, { ...answer, expires_in: "600" }]) {
      expect(() => parseDeviceAuthorization(broken, "https://opencode.ai/console")).toThrow(UpstreamError);
    }
    expect(() => parseDeviceAuthorization({ ...answer, verification_uri_complete: "javascript:alert(1)" }, "https://opencode.ai/console")).toThrow("the device authorization answer lacks a field or names a non-HTTP page: ");
    expect(() => parseDeviceAuthorization(undefined, "https://opencode.ai/console")).toThrow("lacks a field or names a non-HTTP page: {}");
  });

  test("Z17/Z18: token answers (org_id optional or null); pending, slow_down and the end of an authorization; invalid_grant", () => {
    expect(parseTokens({ access_token: "a", refresh_token: "r", expires_in: 3600, org_id: "org_1" }, 1000)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 3_601_000, orgId: "org_1" });
    expect(parseTokens({ access_token: "a", refresh_token: "r", expires_in: 3600, org_id: null }, 0).orgId).toBeUndefined();
    expect(() => parseTokens({ access_token: "a", expires_in: 3600 }, 0)).toThrow('token answer lacks a field: ["access_token","expires_in"]');
    expect([pollError({ error: "authorization_pending" }), pollError({ error: "slow_down" })]).toEqual(["pending", "slow_down"]);
    expect(() => pollError({ error: "access_denied" })).toThrow("opencode: device authorization ended: access_denied");
    expect(() => pollError("x")).toThrow("device authorization ended: no error code");
    expect([isInvalidGrant({ error: "invalid_grant" }), isInvalidGrant({ error: "invalid_request" }), isInvalidGrant(null)]).toEqual([true, false, false]);
  });

  test("Z19: the account is the user's email in the chosen workspace", () => {
    const orgs = [{ id: "org_2", name: "Other" }, { id: "org_1", name: "Team" }];
    expect(consoleIdentity({ id: "u1", email: "me@x" }, orgs, "org_1")).toEqual({ id: "me@x/org_1", label: "me@x (Team)" });
    expect(consoleIdentity({ id: "u1", email: "me@x" }, orgs, "org_9")).toEqual({ id: "me@x/org_9", label: "me@x (org_9)" });
    expect(consoleIdentity({ id: "u1" }, "x", undefined)).toEqual({ id: "u1", label: "u1" });
    expect(() => consoleIdentity({}, [], undefined)).toThrow("the Console user answer has no email or id");
  });

  test("Z20: the documented config example gives each OpenCode provider's headers (strings only)", () => {
    const example = { providers: { opencode: { name: "OpenCode", settings: { baseURL: "https://opencode.ai/inference/openai/v1" }, headers: { "x-opencode-org-id": "org_...", n: 1 } }, "opencode-go": {}, other: { headers: { a: "b" } } } };
    expect(workspaceHeaders(example)).toEqual({ opencode: { "x-opencode-org-id": "org_..." }, "opencode-go": {} });
    expect(workspaceHeaders(null)).toEqual({});
  });

  test("stored credentials: a key, device tokens, the workspace headers kept; anything else unreadable", () => {
    const headers = { opencode: { "x-opencode-org-id": "org_1" } };
    expect(decodeCredential({ apiKey: "oc_sk_1", workspaceHeaders: headers })).toEqual({ kind: "key", key: "oc_sk_1", headers });
    expect(decodeCredential({ apiKey: "oc_sk_1" })).toEqual({ kind: "key", key: "oc_sk_1", headers: {} });
    const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 5, orgId: "org_1" };
    expect(decodeCredential(encodeDevice(tokens, headers))).toEqual({ kind: "device", tokens, headers });
    const noOrg = { ...tokens, orgId: undefined };
    expect(encodeDevice(noOrg, {})).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 5, workspaceHeaders: {} });
    expect(decodeCredential(encodeDevice(noOrg, {}))).toEqual({ kind: "device", tokens: noOrg, headers: {} });
    expect(decodeCredential({ accessToken: "a", refreshToken: "r", expiresAt: "5" })).toBeUndefined();
    expect(decodeCredential({})).toBeUndefined();
  });
});
