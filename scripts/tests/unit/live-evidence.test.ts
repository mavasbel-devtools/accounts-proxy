// The P0-LIVE redactor and recording transport: nothing credential-bearing may reach a capture file.
import { describe, expect, test } from "bun:test";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
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

  test("JSON bodies: credential fields by name at any depth, secrets inside strings, other values kept", () => {
    const body = JSON.stringify({ project: "proj-abcdef", nested: [{ refresh_token: "1//rt", code: 429, note: "for someone@example.com" }], n: 1 });
    expect(JSON.parse(redactor().body(body))).toEqual({ project: "<REDACTED:project>", nested: [{ refresh_token: "<REDACTED:refresh_token>", code: 429, note: "for <REDACTED:email>" }], n: 1 });
  });

  test("form and query credentials are redacted; non-JSON bodies are redacted as text", () => {
    expect(redactor().body("grant_type=refresh_token&refresh_token=1%2F%2Fabc&code=xyz")).toBe("grant_type=refresh_token&refresh_token=<REDACTED:field>&code=<REDACTED:field>");
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
