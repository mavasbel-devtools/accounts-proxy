// Parity with the vendored opencode sources (tests/reference/plugin-35ef229454, byte-identical, MANIFEST.json). They
// import opencode's runtime (effect, @opencode/*), so they are compared as source text: every wire value the router
// copies from them is extracted from the file and compared with the router's constant or request.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_MODELS, ISSUER, JWKS_PATH, REGISTRATION_CLIENT_ID, RESOURCE, SCOPES, SHARING_ERROR_STATUS, TOKEN_PATH } from "@inference-router/provider-openai/domain/constants.ts";

const reference = join(import.meta.dir, "..", "reference", "plugin-35ef229454");
const chatgpt = readFileSync(join(reference, "plugin", "provider", "chatgpt.ts"), "utf8");
const toSessionError = readFileSync(join(reference, "session", "to-session-error.ts"), "utf8");

/** The text between `start` and the next `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`missing ${start}`);
  return text.slice(from + start.length, text.indexOf(end, from + start.length));
}
/** Object keys in source order: `key: value`, shorthand `key,` and the conditional `...(savedID ? {} : { key: … })`. */
const keysOf = (block: string) => [...block.matchAll(/^\s*(?:\/\/\s*)?(?:\.\.\.\(savedID \? \{\} : \{ )?([a-z_]+)(?::|,$)/gm)].map((m) => m[1]!);

describe("chatgpt.ts @ 35ef229454", () => {
  test("constants: issuer, token and JWKS paths, resource, registration client, scope", () => {
    expect(between(chatgpt, 'const issuer = "', '"')).toBe(ISSUER);
    expect(between(chatgpt, "const tokenURL = `${issuer}", "`")).toBe(TOKEN_PATH);
    expect(between(chatgpt, "jwksURL = new URL(`${issuer}", "`")).toBe(JWKS_PATH);
    expect(between(chatgpt, 'const resource = "', '"')).toBe(RESOURCE);
    expect(between(chatgpt, 'const registrationClientID = "', '"')).toBe(REGISTRATION_CLIENT_ID);
    expect(between(chatgpt, 'const tokenSharingScope = "', '"')).toBe("chatgpt.tokens.use.direct");
    expect(between(chatgpt, "scope: `", "`").replace("${tokenSharingScope}", "chatgpt.tokens.use.direct")).toBe(SCOPES);
  });

  test("the built-in model list", () => {
    expect([...between(chatgpt, "const fallbackModels = new Set([", "])").matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...FALLBACK_MODELS]);
  });

  test("authorize, exchange and refresh parameters in the same order", () => {
    const authorize = keysOf(between(chatgpt, "/api/accounts/authorize?${new URLSearchParams({", "})}`")).filter((k) => k !== "force_reconsent");
    expect(authorize).toEqual(["client_id", "agent_name_hint", "ext_agent_host_id", "response_type", "redirect_uri", "scope", "resource", "state", "nonce", "code_challenge_method", "code_challenge"]);
    expect(keysOf(between(between(chatgpt, "function exchange(", "\n}"), "new URLSearchParams({", "})"))).toEqual(["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "resource"]);
    expect(keysOf(between(between(chatgpt, "function refresh(", "\n}"), "new URLSearchParams({", "})"))).toEqual(["grant_type", "client_id", "refresh_token", "resource"]);
    expect(between(chatgpt, "const redirect = `", "`")).toBe("http://127.0.0.1:${port}/auth/callback");
  });

  test("the session headers (decision O9)", () => {
    expect([...between(chatgpt, "// Mirror the Codex client's session headers", "}),").matchAll(/evt\.headers\["([a-z-]+)"\]/g)].map((m) => m[1])).toEqual(["session-id", "thread-id", "x-client-request-id"]);
  });

  test("the plan-usage error codes match opencode's message table and its non-retryable list", () => {
    const messages = [...between(toSessionError, "const tokenSharingMessages = {", "\n}").matchAll(/^\s+([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect([...messages].sort()).toEqual(Object.keys(SHARING_ERROR_STATUS).sort());
    const nonRetryable = [...between(chatgpt, "const nonRetryableSharingCodes = [", "]").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(nonRetryable.every((code) => Object.hasOwn(SHARING_ERROR_STATUS, code))).toBe(true);
  });
});
