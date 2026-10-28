import { describe, expect, test } from "bun:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { canonicalise, maskString, maskValue, REDACTED } from "@accounts-proxy/scripts/recon/parity/canon.ts";
import { cellFor, cellOf } from "@accounts-proxy/scripts/recon/parity/cells.ts";
import { markdown, render } from "@accounts-proxy/scripts/recon/parity/compare.ts";
import { diffRequests } from "@accounts-proxy/scripts/recon/parity/diff.ts";
import { RequestStream } from "@accounts-proxy/scripts/recon/parity/tap.ts";

const uuid = "0f8b6d7b-49a4-4b6e-9c2a-6b143c95c4e6";

describe("canonical form", () => {
  test("per-run values are named, redacted values match anything, identity fields never survive", () => {
    expect(maskString(uuid)).toBe("<uuid>");
    expect(maskString(`agent/${uuid}/1792629126966/${uuid}/8`)).toBe("agent/<uuid>/<epoch-ms>/<uuid>/8");
    expect(maskString("-3750763034362895579")).toBe("<int64>");
    expect(maskString("2026-10-21T18:23:55.546Z")).toBe("<iso-time>");
    expect(maskString("<REDACTED:authorization>")).toBe(REDACTED);
    expect(maskString("msg_011CgEGufrSZB2KMdK39BfTA")).toBe("<message-id>");
    expect(maskString("ok")).toBe("ok");
    // Claude's metadata.user_id: JSON inside a string, compared as JSON; device_id is identity on both sides.
    expect(maskValue({ user_id: JSON.stringify({ device_id: "195b7e7a", session_id: uuid }) })).toEqual({
      user_id: { $json: { device_id: REDACTED, session_id: "<uuid>" } },
    });
    expect(maskValue({ list: ["[not json", "{\"a\":1}"], n: 3, z: null })).toEqual({ list: ["[not json", { $json: { a: 1 } }], n: 3, z: null });
  });

  test("headers keep order and case; transport, credential and account values are placeholders", () => {
    const canonical = canonicalise({
      method: "post",
      url: "https://api.anthropic.com/v1/messages?beta=true&b=2",
      headers: [
        ["Host", "api.anthropic.com"],
        ["Authorization", "Bearer sk-ant-secret"],
        ["x-api-key", "k"],
        ["Content-Length", "12"],
        ["X-Session", uuid],
        ["ChatGPT-Account-Id", "account-a"],
      ],
      body: "",
    });
    expect(canonical.method).toBe("POST");
    expect(canonical.path).toBe("/v1/messages");
    expect(canonical.query).toEqual([["b", "2"], ["beta", "true"]]);
    expect(canonical.headers).toEqual([
      { name: "host", raw: "Host", value: "<host>" },
      { name: "authorization", raw: "Authorization", value: `Bearer ${REDACTED}` },
      { name: "x-api-key", raw: "x-api-key", value: REDACTED },
      { name: "content-length", raw: "Content-Length", value: "<content-length>" },
      { name: "x-session", raw: "X-Session", value: "<uuid>" },
      { name: "chatgpt-account-id", raw: "ChatGPT-Account-Id", value: REDACTED },
    ]);
    expect(canonical.body).toBeNull();
    expect(canonicalise({ method: "POST", url: "/x", headers: [], body: "plain text" }).body).toBe("plain text");
  });
});

describe("differences", () => {
  const base = (overrides: Partial<Parameters<typeof canonicalise>[0]> = {}) =>
    canonicalise({ method: "POST", url: "https://h/v1/m?a=1", headers: [["A", "1"], ["B", "2"]], body: JSON.stringify({ x: 1, list: ["s1", "s2"] }), ...overrides });

  test("identical requests have none", () => {
    expect(diffRequests(base(), base())).toEqual([]);
  });

  test("every kind is reported once, with the client and proxy sides", () => {
    const proxy = canonicalise({
      method: "PUT",
      url: "/v2/m?b=2&a=9",
      headers: [["b", "3"], ["a", "1"], ["C", "4"]],
      body: JSON.stringify({ list: ["s0", "s1", "s2"], y: true, x: "1" }),
    });
    const client = canonicalise({ method: "POST", url: "https://h/v1/m?a=1&c=0", headers: [["A", "1"], ["B", "2"], ["D", "5"]], body: JSON.stringify({ x: 1, list: ["s1", "s2"] }) });
    const kinds = diffRequests(client, proxy).map((gap) => `${gap.kind} ${gap.where}`);
    expect(kinds).toEqual([
      "method method",
      "path path",
      "query-value a",
      "query-missing c",
      "query-extra b",
      "header-case a",
      "header-value b",
      "header-case b",
      "header-missing d",
      "header-extra c",
      "header-order headers",
      "body-type /x",
      "body-length /list",
      "body-extra /list/+0",
      "body-extra /y",
    ]);
    const ignored = diffRequests(client, proxy, new Set(["header-order", "d", "c"])).map((gap) => `${gap.kind} ${gap.where}`);
    expect(ignored).not.toContain("header-order headers");
    expect(ignored).not.toContain("header-missing d");
    expect(ignored).not.toContain("header-extra c");
  });

  test("arrays align on equal elements; leftovers pair by position, then go missing", () => {
    const left = canonicalise({ method: "POST", url: "/m", headers: [], body: JSON.stringify({ t: [{ n: 1 }, { n: 2 }, { n: 3 }] }) });
    const right = canonicalise({ method: "POST", url: "/m", headers: [], body: JSON.stringify({ t: [{ n: 1 }, { n: 9 }] }) });
    expect(diffRequests(left, right).map((gap) => `${gap.kind} ${gap.where}`)).toEqual(["body-length /t", "body-value /t/1/n", "body-missing /t/2"]);
    const swap = canonicalise({ method: "POST", url: "/m", headers: [], body: JSON.stringify({ t: [{ n: 3 }, { n: 1 }] }) });
    expect(diffRequests(left, swap).map((gap) => gap.kind)).toContain("body-missing");
  });

  test("a redacted value matches any value of the same type, ignored headers are not compared, keys with / are escaped", () => {
    const client = canonicalise({ method: "POST", url: "/m", headers: [["transfer-encoding", "chunked"]], body: JSON.stringify({ "a/b~c": "<REDACTED:email>", n: 1 }) });
    const proxy = canonicalise({ method: "POST", url: "/m", headers: [], body: JSON.stringify({ "a/b~c": "someone", n: 2 }) });
    expect(diffRequests(client, proxy, new Set(["transfer-encoding"]))).toEqual([{ kind: "body-value", where: "/n", client: 1, proxy: 2 }]);
    const typed = canonicalise({ method: "POST", url: "/m", headers: [], body: JSON.stringify({ "a/b~c": 5, n: 1 }) });
    expect(diffRequests(client, typed).map((gap) => gap.where)).toEqual(["transfer-encoding", "/a~1b~0c"]);
    expect(diffRequests(canonicalise({ method: "POST", url: "/m", headers: [], body: "1" }), canonicalise({ method: "POST", url: "/m", headers: [], body: "2" }))).toEqual([
      { kind: "body-value", where: "/", client: 1, proxy: 2 },
    ]);
  });
});

describe("wire tap parser", () => {
  test("content-length and chunked requests, split across reads, keep header order and case", () => {
    const seen: { method: string; url: string; headers: readonly (readonly [string, string])[]; body: string }[] = [];
    const stream = new RequestStream((request) => seen.push(request));
    const first = "POST /v1/messages HTTP/1.1\r\nHost: x\r\nX-B: 2\r\nx-a: 1\r\nContent-Length: 5\r\n\r\nhello";
    const second = "POST /v1internal:streamGenerateContent HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\n\r\n";
    const bytes = Buffer.from(first + second);
    for (let index = 0; index < bytes.length; index += 7) stream.push(bytes.subarray(index, index + 7));
    expect(seen.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "/v1/messages", "hello"],
      ["POST", "/v1internal:streamGenerateContent", "abcde"],
    ]);
    expect(seen[0]!.headers).toEqual([["Host", "x"], ["X-B", "2"], ["x-a", "1"], ["Content-Length", "5"]]);
    expect(() => new RequestStream(() => undefined).push(Buffer.from("GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"))).toThrow(/malformed chunk/);
    const empty: unknown[] = [];
    new RequestStream((request) => empty.push(request)).push(Buffer.from("GET /health HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(empty).toHaveLength(1);
  });

  test("a zstd or gzip body is decoded like plane A's; the content-encoding header itself is kept", () => {
    const seen: { headers: readonly (readonly [string, string])[]; body: string }[] = [];
    const stream = new RequestStream((request) => seen.push(request));
    for (const [encoding, frame] of [["zstd", zstdCompressSync(Buffer.from('{"a":1}'))], ["gzip", gzipSync(Buffer.from('{"b":2}'))]] as const) {
      stream.push(Buffer.concat([Buffer.from(`POST /v1/responses HTTP/1.1\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${frame.length}\r\n\r\n`), frame]));
    }
    expect(seen.map((request) => [request.headers[0], request.body])).toEqual([
      [["Content-Encoding", "zstd"], '{"a":1}'],
      [["Content-Encoding", "gzip"], '{"b":2}'],
    ]);
  });
});

describe("cells", () => {
  test("claude keeps the client's headers in order with the proxy token, and names the model by provider", () => {
    const input = cellFor("claude").input(
      {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages?beta=true",
        headers: [["Accept", "application/json"], ["Authorization", "Bearer <REDACTED:authorization>"], ["Host", "api.anthropic.com"], ["Content-Length", "9"]],
        body: JSON.stringify({ model: "claude-opus-5-5", stream: true }),
      },
      "tok",
    );
    expect(input).toEqual({
      target: "/anthropic/v1/messages?beta=true",
      headers: [["Accept", "application/json"], ["Authorization", "Bearer tok"]],
      body: JSON.stringify({ model: "claude/claude-opus-5-5", stream: true }),
    });
  });

  test("antigravity sends the inner Gemini request without the envelope-only fields", () => {
    const input = cellFor("antigravity").input(
      {
        method: "POST",
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        headers: [],
        body: JSON.stringify({ model: "gemini-3.8-flash-high", project: "p", request: { contents: [], sessionId: "-1", labels: { a: "1" }, tools: [] } }),
      },
      "tok",
    );
    expect(input).toEqual({
      target: "/gemini/v1beta/models/antigravity%2Fgemini-3.8-flash-high:streamGenerateContent?alt=sse",
      headers: [["content-type", "application/json"], ["x-goog-api-key", "tok"]],
      body: JSON.stringify({ contents: [], tools: [] }),
    });
    expect(() => cellFor("codex")).toThrow(/no parity cell for codex/);
  });

  test("opencode maps every endpoint family of Zen and Go to the proxy route, keeps its headers in order, swaps only the key", () => {
    const cell = cellFor("opencode");
    const headers = [
      ["Authorization", "Bearer <REDACTED:authorization>"],
      ["Content-Type", "application/json"],
      ["User-Agent", "opencode/latest/2.1.1/cli"],
      ["b3", "t-s-1-p"],
      ["x-opencode-org-id", "<REDACTED:workspace>"],
      ["x-opencode-session", "ses_1"],
      ["Connection", "keep-alive"],
      ["Accept", "*/*"],
      ["Host", "opencode.ai"],
      ["Accept-Encoding", "gzip"],
      ["Content-Length", "10"],
    ] as const;
    const map = (url: string, body: unknown = { model: "m", messages: [] }) => cell.input({ method: "POST", url, headers, body: JSON.stringify(body) }, "tok");
    const chat = map("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(chat).toEqual({
      target: "/openai/v1/chat/completions",
      headers: [["Authorization", "Bearer tok"], ["Content-Type", "application/json"], ["User-Agent", "opencode/latest/2.1.1/cli"], ["b3", "t-s-1-p"], ["x-opencode-session", "ses_1"]],
      body: JSON.stringify({ model: "opencode-go/m", messages: [] }),
    });
    expect([map("https://opencode.ai/inference/openai/v1/responses").target, JSON.parse(map("https://opencode.ai/inference/openai/v1/responses").body).model]).toEqual(["/openai/v1/responses", "opencode/m"]);
    expect(map("https://opencode.ai/inference/go/anthropic/v1/messages").target).toBe("/anthropic/v1/messages");
    const gemini = cell.input({ method: "POST", url: "https://opencode.ai/inference/go/google/v1beta/models/g-1:streamGenerateContent?alt=sse", headers: [["x-goog-api-key", "<REDACTED:x-goog-api-key>"]], body: '{"contents":[]}' }, "tok");
    expect(gemini).toEqual({ target: "/gemini/v1beta/models/opencode-go%2Fg-1:streamGenerateContent?alt=sse", headers: [["x-goog-api-key", "tok"]], body: '{"contents":[]}' });
    expect(() => map("https://opencode.ai/inference/openai/v1/embeddings")).toThrow("no proxy route for the OpenCode request /inference/openai/v1/embeddings");
    expect([cell.isCounterpart!("/inference/go/openai/v1/responses"), cell.isCounterpart!("/inference/go/v1/models"), cell.isCounterpart!("/console/api/v2/config")]).toEqual([true, false, false]);
    expect(cell.daemon!.providers).toBe("  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n");
  });

  test("openai: opencode's ChatGPT request maps to the Responses route without its content-encoding; other clients keep their cell", () => {
    const headers = [
      ["Authorization", "Bearer <REDACTED:authorization>"],
      ["Content-Encoding", "zstd"],
      ["Content-Type", "application/json"],
      ["User-Agent", "opencode/latest/2.1.1/cli"],
      ["session-id", "ses_1"],
      ["Connection", "keep-alive"],
      ["Accept", "*/*"],
      ["Content-Length", "10"],
    ] as const;
    const cell = cellOf("opencode", "https://api.openai.com/v1/responses");
    expect(cell.input({ method: "POST", url: "https://api.openai.com/v1/responses", headers, body: '{"model":"gpt-6-luna","input":[]}' }, "tok")).toEqual({
      target: "/openai/v1/responses",
      headers: [["Authorization", "Bearer tok"], ["Content-Type", "application/json"], ["User-Agent", "opencode/latest/2.1.1/cli"], ["session-id", "ses_1"]],
      body: JSON.stringify({ model: "openai/gpt-6-luna", input: [] }),
    });
    expect([cell.client, cell.upstreamPath, cell.daemon!.providers]).toEqual(["opencode", "/v1/responses", "  openai: {enabled: true, acknowledgeTermsRisk: true}\n"]);
    expect(Object.keys(cell.daemon!.pools)).toEqual(["openai"]);
    expect(cellOf("opencode", "https://opencode.ai/inference/openai/v1/responses")).toBe(cellFor("opencode"));
    expect(cellOf("claude", "https://api.anthropic.com/v1/messages")).toBe(cellFor("claude"));
  });

  test("identity patterns of the manifest are masked on both sides: the OpenCode workspace id and its redacted mark compare equal", () => {
    expect(maskString("wrk_01PARITYPARITYPARITYPARITY")).toBe(REDACTED);
    expect(maskString("<REDACTED:workspace>")).toBe(REDACTED);
    expect(maskString("see ada@example.org")).toBe(`see ${REDACTED}`);
  });
});

describe("report", () => {
  test("long values are summarised and table characters escaped", () => {
    expect(render(undefined)).toBe("—");
    expect(render("a|b`c")).toBe("`a\\|b'c`");
    expect(render("x".repeat(200))).toMatch(/^`200 chars, sha256 [0-9a-f]{12}: x{80}…`$/);
    const text = markdown({
      capture: { client: "claude", version: "2.1.304", run: "claude/r/turn", seq: 18, url: "https://api.anthropic.com/v1/messages?beta=true", httpVersion: "HTTP/1.1" },
      mapping: "mapping",
      proxy: { status: 200, upstreamRequests: 1, httpVersion: "HTTP/1.1", otherUpstream: ["GET /v1/models"] },
      refusal: { status: 400, body: "no", dropped: "anthropic-beta:x" },
      gaps: [{ kind: "header-missing", where: "x-a", client: "1" }],
    });
    expect(text).toContain("seq 18");
    expect(text).toContain("`https://api.anthropic.com/v1/messages`");
    expect(text).toContain("**Refused as sent:** 400");
    expect(text).toContain("which dropped `anthropic-beta:x`");
    expect(text).toContain("| 1 | header-missing | `x-a` | `1` | — |");
    expect(text).toContain("Other proxy upstream calls during this request: `GET /v1/models`.");
    const bare = markdown({ capture: { client: "c", version: "v", run: "r", seq: 1, url: "u" }, mapping: "m", proxy: { status: 200, upstreamRequests: 1, otherUpstream: [] }, gaps: [] });
    expect(bare).toContain("0 difference(s).");
    expect(bare).toContain("Other proxy upstream calls during this request: none.");
  });
});
