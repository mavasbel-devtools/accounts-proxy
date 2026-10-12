import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSnapshot, nextCursor, parseCatalogEntry, type ModelsPage } from "@inference-router/provider-claude/domain/catalog.ts";
import { API_BASE, AUTHORIZE_SCOPES, REFRESH_SCOPES } from "@inference-router/provider-claude/domain/constants.ts";
import { fromAccount, hasScope, toAccount, tokensFromResponse, type ClaudeTokens } from "@inference-router/provider-claude/domain/credential.ts";
import { capabilitiesEnvelope, envelopeFor, FALLBACK_ENVELOPE, MODEL_ENVELOPES, STATIC_CATALOG, type CatalogModelEntry } from "@inference-router/provider-claude/domain/model-envelope.ts";
import { apiUrl, guardAndNormalize, sanitizeThinking, transformRequest } from "@inference-router/provider-claude/domain/request-transform.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "plugin-6292741");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;

describe("constants", () => {
  test("authorize scopes = captured plugin scope + user:plugins (official 2.1.280 kCr)", () => {
    const captured = json<{ scope: string }>("authorize-params.json").scope;
    expect(AUTHORIZE_SCOPES.join(" ")).toBe(`${captured} user:plugins`);
    expect(REFRESH_SCOPES.join(" ")).toBe(`${json<{ scope: string }>("refresh-request.json").scope} user:plugins`);
  });
});

describe("credential", () => {
  const response = json<Record<string, unknown>>("refresh-response.json");
  test("tokensFromResponse maps the captured token response", () => {
    expect(tokensFromResponse(response, 1000)).toEqual({
      accessToken: "sk-ant-oat01-REDACTED",
      refreshToken: "sk-ant-oat01-REDACTED",
      expiresAt: 1000 + 28_800_000,
      scopes: "user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code",
      accountUuid: "00000000-0000-4000-8000-000000000000",
      organizationUuid: "e7ac4584-ce93-4714-9ffb-0553b2897eea",
      email: "<account-email>",
    });
  });
  test("a response without refresh token / identity keeps the previous values", () => {
    const previous: ClaudeTokens = { accessToken: "old", refreshToken: "r0", expiresAt: 0, scopes: "a b", accountUuid: "u", organizationUuid: "o", email: "e" };
    expect(tokensFromResponse({ access_token: "new", expires_in: 10 }, 5, previous)).toEqual({ ...previous, accessToken: "new", expiresAt: 10_005 });
    expect(tokensFromResponse({ access_token: "new", expires_in: 10 }, 5)).toEqual({ accessToken: "new", expiresAt: 10_005, scopes: "" });
  });
  test.each([[{}], [{ access_token: "", expires_in: 1 }], [{ access_token: "a", expires_in: "1" }], [{ access_token: "a", expires_in: Number.NaN }]])(
    "rejects %p",
    (bad) => {
      expect(() => tokensFromResponse(bad, 0)).toThrow("token endpoint response lacks access_token/expires_in");
    },
  );
  test("hasScope", () => {
    expect(hasScope({ accessToken: "a", expiresAt: 0, scopes: "user:profile  user:inference" }, "user:inference")).toBe(true);
    expect(hasScope({ accessToken: "a", expiresAt: 0, scopes: "user:profile" }, "user:inference")).toBe(false);
  });
  test("toAccount/fromAccount round trip and id selection", () => {
    const full: ClaudeTokens = { accessToken: "a", refreshToken: "r", expiresAt: 9, scopes: "s", accountUuid: "u", organizationUuid: "o", email: "me@x" };
    const account = toAccount(full);
    expect(account).toMatchObject({ provider: "claude", id: "me@x", label: "me@x" });
    expect(fromAccount(account)).toEqual(full);
    expect(toAccount({ accessToken: "a", expiresAt: 9, scopes: "s", accountUuid: "u" }).id).toBe("u");
    const bare = toAccount({ accessToken: "a", expiresAt: 9, scopes: "s" });
    expect(bare.id).toBe("claude-account");
    expect(fromAccount(bare)).toEqual({ accessToken: "a", expiresAt: 9, scopes: "s" });
  });
  test.each([[{}], [{ accessToken: "a", expiresAt: "9", scopes: "s" }], [{ accessToken: "a", expiresAt: 9 }]])("fromAccount rejects data %p", (data) => {
    expect(fromAccount({ provider: "claude", id: "x", label: "x", data })).toBeUndefined();
  });
});

describe("catalog parsing", () => {
  test("the captured live /v1/models response parses entry-for-entry into STATIC_CATALOG", () => {
    const page = json<ModelsPage>("catalog-api-response.json");
    const parsed = (page.data ?? []).map(parseCatalogEntry);
    expect(parsed).toEqual([...STATIC_CATALOG]);
  });
  test("entries without an id are skipped; garbage degrades to zero/false", () => {
    expect(parseCatalogEntry({})).toBeNull();
    expect(parseCatalogEntry({ id: "" })).toBeNull();
    const entry = parseCatalogEntry({ id: "m", max_input_tokens: -1, max_tokens: "big", capabilities: { batch: { supported: "yes" }, effort: { supported: true, high: null } } });
    expect(entry).toMatchObject({ id: "m", displayName: "m", createdAt: "", maxInputTokens: 0, maxTokens: 0 });
    expect(entry?.capabilities?.batch).toBe(false);
    expect(entry?.capabilities?.effort).toEqual({ supported: true, levels: [] });
  });
  test("nextCursor", () => {
    const parsed = [{ id: "a" }, { id: "b" }] as CatalogModelEntry[];
    expect(nextCursor({ has_more: false, last_id: "z" }, parsed)).toBeUndefined();
    expect(nextCursor({ has_more: true, last_id: "z" }, parsed)).toBe("z");
    expect(nextCursor({ has_more: true, last_id: "" }, parsed)).toBe("b");
    expect(nextCursor({ has_more: true }, [])).toBeUndefined();
  });
  test.each([
    [{ version: 2, fetchedAt: 1, models: [{}] }, true],
    [{ version: 1, fetchedAt: 1, models: [{}] }, false],
    [{ version: 2, fetchedAt: "1", models: [{}] }, false],
    [{ version: 2, fetchedAt: 1, models: [] }, false],
    [{ version: 2, fetchedAt: 1, models: {} }, false],
    [null, false],
    ["x", false],
  ])("isSnapshot(%p) = %p", (value, expected) => {
    expect(isSnapshot(value)).toBe(expected);
  });
});

describe("model envelope", () => {
  test("lookup order: captured table, alias, catalog capabilities, fallback", () => {
    expect(envelopeFor("claude-opus-4-8", undefined)).toBe(MODEL_ENVELOPES["claude-opus-4-8"]!);
    expect(envelopeFor("claude-haiku-4-5", undefined)).toBe(FALLBACK_ENVELOPE);
    expect(envelopeFor("claude-unknown", undefined)).toBe(FALLBACK_ENVELOPE);
    expect(envelopeFor("claude-unknown", { id: "x", displayName: "x", createdAt: "", maxInputTokens: 0, maxTokens: 0 })).toBe(FALLBACK_ENVELOPE);
  });
  test("F8: prototype keys are not model ids", () => {
    expect(envelopeFor("toString", undefined)).toBe(FALLBACK_ENVELOPE);
    expect(envelopeFor("constructor", undefined)).toBe(FALLBACK_ENVELOPE);
  });
  test("capabilitiesEnvelope", () => {
    const base = STATIC_CATALOG[0]!;
    expect(capabilitiesEnvelope(base)).toEqual({
      betaHeader: FALLBACK_ENVELOPE.betaHeader,
      thinking: { type: "adaptive", display: "omitted" },
      maxTokens: 32_000,
      outputConfig: { effort: "high" },
      limit: { context: 1_000_000, output: 128_000 },
    });
    const bare = capabilitiesEnvelope({ id: "x", displayName: "x", createdAt: "", maxInputTokens: 0, maxTokens: 0 });
    expect(bare).toEqual({ betaHeader: FALLBACK_ENVELOPE.betaHeader, thinking: { type: "enabled", display: "omitted", budget_tokens: 31999 }, maxTokens: 32_000, limit: FALLBACK_ENVELOPE.limit });
    const small = capabilitiesEnvelope({ ...base, maxTokens: 8000, capabilities: { ...base.capabilities!, effort: { supported: true, levels: ["low"] } } });
    expect(small.maxTokens).toBe(8000);
    expect(small.outputConfig).toBeUndefined();
    // effort "high" advertised but thinking not adaptive (claude-opus-4-5): enabled thinking, no output_config
    const opus45 = capabilitiesEnvelope(STATIC_CATALOG.find((e) => e.id === "claude-opus-4-5-20251101")!);
    expect(opus45.thinking.type).toBe("enabled");
    expect(opus45.outputConfig).toBeUndefined();
  });
});

describe("request-transform edge branches", () => {
  test("sanitizeThinking falls back to the envelope's thinking", () => {
    const adaptive = MODEL_ENVELOPES["claude-opus-4-8"]!.thinking;
    expect(sanitizeThinking(undefined, adaptive)).toEqual(adaptive);
    expect(sanitizeThinking({}, adaptive)).toEqual(adaptive);
    expect(sanitizeThinking({ type: "weird" }, adaptive)).toEqual(adaptive);
  });
  test("non-tool_use assistant blocks and tool messages without any id", () => {
    expect(
      guardAndNormalize([
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: 7 }] },
        { role: "tool", content: "no id" },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: 7 }] },
      { role: "user", content: "next" },
    ]);
  });
  test("production api base", () => {
    expect(apiUrl("/v1/messages", API_BASE)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const ctx = { accessToken: "a", accountUuid: "", deviceId: "d", sessionId: "s", previousMessageId: null, ccPromptId: "p", clientRequestId: "c" };
    expect(transformRequest({ body: { model: "m", messages: [] }, path: "/v1/messages", betaHeader: "b" }, ctx, () => undefined, API_BASE).url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });
});

describe("guard idempotence (L4)", () => {
  test("a second pass changes nothing", () => {
    const once = guardAndNormalize([
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: {} }] },
      { role: "tool", content: "r", tool_use_id: "t" },
      { role: "assistant", content: "x" },
    ]);
    expect(guardAndNormalize(once)).toEqual(once);
  });
});
