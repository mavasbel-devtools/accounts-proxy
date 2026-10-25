// The P0-LIVE redactor and recording transport: nothing credential-bearing may reach a capture file.
import { describe, expect, test } from "bun:test";
import { orderedHeaders, readAll } from "@accounts-proxy/core/domain/wire.ts";
import { ScriptedTransport } from "@accounts-proxy/test-support/fakes.ts";
import { Redactor } from "@accounts-proxy/scripts/evidence/live/redact.ts";
import { RecordingTransport } from "@accounts-proxy/scripts/evidence/live/recording-transport.ts";

function redactor(): Redactor {
  const r = new Redactor();
  r.add("email", "someone@example.com");
  r.add("access_token", "ya29.secret-access");
  r.add("project", "proj-abcdef");
  return r;
}

describe("Redactor", () => {
  test("replaces every occurrence, longest first, and URL-encoded forms", () => {
    const r = redactor();
    r.add("email_user", "someone@example");
    expect(r.text("to someone@example.com and someone%40example.com")).toBe("to <REDACTED:email> and <REDACTED:email>");
  });

  test("ignores empty values, deduplicates, and refuses values too short to redact safely", () => {
    const r = redactor();
    r.add("none", undefined);
    r.add("null", null);
    r.add("empty", "");
    r.add("again", "proj-abcdef");
    expect(r.size).toBe(3);
    expect(() => r.add("short", "abc")).toThrow("too short");
  });

  test("credential headers are replaced by name, keeping the scheme", () => {
    const out = redactor().headers({ Authorization: "Bearer anything", "x-goog-api-key": "k", "X-Project": "proj-abcdef", accept: "text/event-stream" });
    expect(out).toEqual({ authorization: "Bearer <REDACTED:authorization>", "x-goog-api-key": "<REDACTED:x-goog-api-key>", "x-project": "<REDACTED:project>", accept: "text/event-stream" });
  });

  test("ordered header pairs are redacted in their order, without the name index the pairs also carry", () => {
    const pairs = orderedHeaders([["Accept", "application/json"], ["Authorization", "Bearer anything"], ["X-Project", "proj-abcdef"]]);
    const out = redactor().headers(pairs);
    expect(Object.keys(out)).toEqual(["accept", "authorization", "x-project"]);
    expect(out).toEqual({ accept: "application/json", authorization: "Bearer <REDACTED:authorization>", "x-project": "<REDACTED:project>" });
  });

  test("fixtures are named instead of repeated, so their bytes cannot trip the token-prefix scan", () => {
    const r = redactor();
    const payload = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAA1//wYXRh";
    expect(r.scan(payload)).toEqual(["prefix:1//"]);
    r.fixture("code-word.wav", payload);
    r.fixture("code-word.wav", payload);
    const out = r.body(JSON.stringify({ parts: [{ inlineData: { mimeType: "audio/wav", data: payload } }] }));
    expect(out).toBe('{"parts":[{"inlineData":{"mimeType":"audio/wav","data":"<FIXTURE:code-word.wav>"}}]}');
    expect(r.scan(out)).toEqual([]);
    expect(() => r.fixture("tiny", "abc")).toThrow("too short");
  });

  test("JSON bodies: credential fields by name at any depth, secrets inside strings, other values kept", () => {
    const body = JSON.stringify({ project: "proj-abcdef", nested: [{ refresh_token: "1//rt", code: 429, note: "for someone@example.com" }], n: 1 });
    expect(JSON.parse(redactor().body(body))).toEqual({ project: "<REDACTED:project>", nested: [{ refresh_token: "<REDACTED:refresh_token>", code: 429, note: "for <REDACTED:email>" }], n: 1 });
  });

  test("form and query credentials are redacted; non-JSON bodies are redacted as text", () => {
    expect(redactor().body("grant_type=refresh_token&refresh_token=1%2F%2Fabc&code=xyz")).toBe("grant_type=refresh_token&refresh_token=<REDACTED:field>&code=<REDACTED:field>");
  });

  test("identity: emails anywhere, identity fields, nested JSON strings, and only endpoint-scoped names", () => {
    expect(redactor().text("write to ada@example.org")).toBe("write to <REDACTED:email>");

    const profile = JSON.stringify({ id: "101", email: "ada@example.org", name: "Ada", given_name: "Ada", picture: "https://p/x.png", verified_email: true });
    expect(JSON.parse(redactor().body(profile, "https://www.googleapis.com/oauth2/v2/userinfo"))).toEqual({
      id: "<REDACTED:id>",
      email: "<REDACTED:email>",
      name: "<REDACTED:name>",
      given_name: "<REDACTED:given_name>",
      picture: "<REDACTED:picture>",
      verified_email: true,
    });

    // Claude's metadata.user_id is a JSON document carried as a string.
    const wrapped = JSON.parse(redactor().body(JSON.stringify({ metadata: { user_id: JSON.stringify({ device_id: "d-1", account_uuid: "u-1", session_id: "s" }) } }))) as { metadata: { user_id: string } };
    expect(JSON.parse(wrapped.metadata.user_id)).toEqual({ device_id: "<REDACTED:device_id>", account_uuid: "<REDACTED:account_uuid>", session_id: "s" });

    // Claude Code's organisation UUID: in the path and in three body spellings; an unrelated `uuid` is kept.
    const org = "e60f8b6d-0000-4000-8000-000000000001";
    expect(redactor().text(`https://api.anthropic.com/api/organizations/${org}/model_selector/cc`)).toBe(
      "https://api.anthropic.com/api/organizations/<REDACTED:organization>/model_selector/cc",
    );
    expect(JSON.parse(redactor().body(JSON.stringify({ organization_uuid: org, organizationUUID: org, accountUUID: org, uuid: "kept-1" })))).toEqual({
      organization_uuid: "<REDACTED:organization_uuid>",
      organizationUUID: "<REDACTED:organizationUUID>",
      accountUUID: "<REDACTED:accountUUID>",
      uuid: "kept-1",
    });

    // The OpenCode Console workspace id: a header value and the workspace config's provider headers (measured 2026-10-20).
    const workspace = "wrk_01AAAAAAAAAAAAAAAAAAAAAAAA";
    expect(redactor().text(`x-opencode-org-id: ${workspace}`)).toBe("x-opencode-org-id: <REDACTED:workspace>");
    expect(JSON.parse(redactor().body(JSON.stringify({ providers: { "opencode-go": { headers: { "x-opencode-org-id": workspace } } } })))).toEqual({
      providers: { "opencode-go": { headers: { "x-opencode-org-id": "<REDACTED:workspace>" } } },
    });

    // OpenAI's user id, echoed by plan usage in every response's `safety_identifier` (measured 2026-10-24, recon run
    // opencode/2026-10-24-07-08-58): the field in JSON, the pattern in the event-stream text.
    const user = "user-AAAAAAAAAAAAAAAAAAAAAAAA";
    expect(redactor().text(`data: {"response":{"safety_identifier":"${user}"}}`)).toBe('data: {"response":{"safety_identifier":"<REDACTED:openai-user>"}}');
    expect(JSON.parse(redactor().body(JSON.stringify({ response: { safety_identifier: user } })))).toEqual({ response: { safety_identifier: "<REDACTED:safety_identifier>" } });
    expect(redactor().text("user-agent: opencode/latest/2.1.1/cli")).toBe("user-agent: opencode/latest/2.1.1/cli");

    // Codex's ChatGPT account id: a header whose value recurs as a bare array element and an object `id`, and the
    // install id inside the turn-metadata header (measured 2026-10-25, recon runs codex/2026-10-25-01-52-*).
    const account = "8b7f0000-0000-4000-8000-000000000001";
    const r = redactor();
    expect(r.headers({ "ChatGPT-Account-Id": account, "x-codex-turn-metadata": JSON.stringify({ installation_id: "i-123456", turn: 1 }) })).toEqual({
      "chatgpt-account-id": "<REDACTED:chatgpt-account-id>",
      "x-codex-turn-metadata": JSON.stringify({ installation_id: "<REDACTED:installation_id>", turn: 1 }),
    });
    expect(JSON.parse(r.body(JSON.stringify({ accounts: [{ id: account, account_user_id: "u__a" }], default_account_id: account, account_ordering: [account] })))).toEqual({
      accounts: [{ id: "<REDACTED:chatgpt-account-id>", account_user_id: "<REDACTED:account_user_id>" }],
      default_account_id: "<REDACTED:default_account_id>",
      account_ordering: ["<REDACTED:chatgpt-account-id>"],
    });
    expect(JSON.parse(r.body(JSON.stringify({ meta: JSON.stringify({ installation_id: "i-123456" }) })))).toEqual({ meta: JSON.stringify({ installation_id: "<REDACTED:installation_id>" }) });
    expect(redactor().headers({ "chatgpt-account-id": "short" })).toEqual({ "chatgpt-account-id": "<REDACTED:chatgpt-account-id>" });
    // A signed download link's `sig` is a credential; its other parameters are kept.
    expect(redactor().text("https://x.blob.example/f/raw?se=2026&sp=r&sig=abc%2Bdef")).toBe("https://x.blob.example/f/raw?se=2026&sp=r&sig=<REDACTED:field>");

    // `name` is a model name off a profile route: scoped redaction must not touch it.
    const model = JSON.stringify({ model: { name: "claude-opus-5-5" } });
    expect(redactor().body(model, "https://api.anthropic.com/v1/messages")).toBe(model);
  });

  test("scan reports surviving secrets and token prefixes", () => {
    const r = redactor();
    expect(r.scan("clean")).toEqual([]);
    expect(r.scan("someone@example.com sk-ant-x ya29.secret-access 1//x eyJhbGciOiJSUzI1NiJ9.e30.x sk-or-v1-x oc_sk_x ci_live_x ir_live_x")).toEqual([
      "secret:email",
      "secret:access_token",
      "prefix:sk-ant-",
      "prefix:ya29.",
      "prefix:1//",
      "prefix:eyJhbGci",
      "prefix:sk-or-",
      "prefix:oc_sk_",
      "prefix:ci_live_",
      "prefix:ir_live_",
    ]);
  });
});

describe("RecordingTransport", () => {
  test("records the request, status, headers and every chunk with its arrival time", async () => {
    let t = 0;
    const inner = new ScriptedTransport(() => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: "data: 1\n\n" }));
    const rec = new RecordingTransport(inner, () => (t += 5));
    const mark = rec.mark();
    const res = await rec.send({ method: "POST", url: "https://x/y", headers: { a: "b" }, body: "{}" });
    expect(await readAll(res.body)).toBe("data: 1\n\n");
    const [e] = rec.since(mark);
    expect(e!.request.url).toBe("https://x/y");
    expect(e!.status).toBe(200);
    expect(e!.headersAtMs).toBe(5);
    expect(e!.chunks.map((c) => c.text).join("")).toBe("data: 1\n\n");
    expect(e!.doneAtMs).toBeGreaterThan(e!.headersAtMs!);
  });

  test("records transport failures and body failures", async () => {
    const failing = new RecordingTransport(new ScriptedTransport(() => { throw new Error("down"); }));
    await expect(failing.send({ method: "GET", url: "https://x", headers: {} })).rejects.toThrow("down");
    expect(failing.exchanges[0]!.error).toContain("down");

    const broken = new RecordingTransport(
      new ScriptedTransport(() => ({
        status: 200,
        body: async function* () {
          yield new TextEncoder().encode("partial");
          throw new Error("reset");
        },
      })),
    );
    const res = await broken.send({ method: "GET", url: "https://x", headers: {} });
    await expect(readAll(res.body)).rejects.toThrow("reset");
    expect(broken.exchanges[0]!.error).toContain("reset");
    expect(broken.exchanges[0]!.chunks[0]!.text).toBe("partial");
  });
});
