// One loopback replay server standing in for every upstream host the daemon talks to; the composition root's
// INFERENCE_ROUTER_TEST_UPSTREAM_* seams point all four origins here (paths are the production paths). Every response
// body is a committed capture: the source plugins' fixtures (plugin-6292741, plugin-5c6f7c2) or the router's own
// redacted P0-LIVE captures. Non-streamed Claude messages are assembled from a captured stream's events (no
// non-streamed capture exists); count_tokens answers the spec's example (anthropic-count-tokens.md Response 200).
// Every request is recorded so tests can assert what the daemon really sent.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Recorded = { readonly method: string; readonly path: string; readonly search: string; readonly headers: Record<string, string>; readonly body: string };

const repo = join(import.meta.dir, "..", "..", "..");
const claudeFixture = (name: string) => readFileSync(join(repo, "packages", "provider-claude", "tests", "fixtures", "plugin-6292741", name), "utf8");
const antigravityFixture = (name: string) => readFileSync(join(repo, "packages", "provider-antigravity", "tests", "fixtures", "plugin-5c6f7c2", name), "utf8");
type Capture = { exchanges: { response: { status: number; headers: Record<string, string>; chunks: { text: string }[] } }[] };
const capture = (relative: string): Capture => JSON.parse(readFileSync(join(repo, "tests", "fixtures", "captures", "p0-live", relative), "utf8")) as Capture;
const captured = (relative: string, index = 0) => {
  const exchange = capture(relative).exchanges[index]!.response;
  return { status: exchange.status, contentType: exchange.headers["content-type"] ?? "text/event-stream", body: exchange.chunks.map((c) => c.text).join("") };
};

/** A non-streamed Messages response rebuilt from a captured stream: message_start's message + blocks + final delta. */
export function messageFromStream(sse: string): Record<string, unknown> {
  const events = sse
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>);
  const message = { ...(events.find((e) => e["type"] === "message_start")!["message"] as Record<string, unknown>) };
  const blocks: Record<string, unknown>[] = [];
  const json: string[] = [];
  for (const e of events) {
    const i = e["index"] as number;
    if (e["type"] === "content_block_start") {
      blocks[i] = { ...(e["content_block"] as Record<string, unknown>) };
      json[i] = "";
    }
    if (e["type"] === "content_block_delta") {
      const d = e["delta"] as Record<string, string>;
      if (d["type"] === "text_delta") blocks[i]!["text"] = `${blocks[i]!["text"] as string}${d["text"]}`;
      if (d["type"] === "thinking_delta") blocks[i]!["thinking"] = `${blocks[i]!["thinking"] as string}${d["thinking"]}`;
      if (d["type"] === "signature_delta") blocks[i]!["signature"] = d["signature"];
      if (d["type"] === "input_json_delta") json[i] += d["partial_json"]!;
    }
    if (e["type"] === "message_delta") {
      Object.assign(message, e["delta"] as object);
      message["usage"] = { ...(message["usage"] as object), ...(e["usage"] as object) };
    }
  }
  message["content"] = blocks.map((b, i) => (b["type"] === "tool_use" ? { ...b, input: json[i] ? JSON.parse(json[i]!) : {} } : b));
  return message;
}

export class ReplayUpstreams {
  readonly requests: Recorded[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  get origin(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  /** The seam variables pointing every provider host at this server. */
  seamEnv(): Record<string, string> {
    return {
      INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API: this.origin,
      INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH: this.origin,
      INFERENCE_ROUTER_TEST_UPSTREAM_ANTIGRAVITY_API: this.origin,
      INFERENCE_ROUTER_TEST_UPSTREAM_GOOGLE_OAUTH: this.origin,
    };
  }

  start(): this {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.answer(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  find(path: string): Recorded[] {
    return this.requests.filter((r) => r.path === path);
  }

  private async answer(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => (headers[name] = value));
    const body = await req.text();
    this.requests.push({ method: req.method, path: url.pathname, search: url.search, headers, body });
    const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json", ...extra } });
    const sse = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    const parsed = (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();

    switch (url.pathname) {
      case "/v1/oauth/token":
        return json(claudeFixture("refresh-response.json"));
      case "/v1/models":
        return json(claudeFixture("catalog-api-response.json"));
      case "/v1/messages/count_tokens":
        return json({ input_tokens: 2095 });
      case "/v1/messages": {
        if (parsed["model"] === "claude-rate-limited") {
          return json({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit." } }, 429, { "retry-after": "17", "request-id": "req_e2e" });
        }
        const stream = Array.isArray(parsed["tools"]) ? claudeFixture("messages-tooluse-response.sse") : parsed["thinking"] !== undefined ? claudeFixture("messages-thinking-response.sse") : claudeFixture("messages-single-response.sse");
        return parsed["stream"] === true ? sse(stream) : json(messageFromStream(stream), 200, { "request-id": "req_e2e" });
      }
      case "/token":
        return json({ access_token: "e2e-google-access", refresh_token: "e2e-google-refresh", expires_in: 3599 });
      case "/oauth2/v2/userinfo":
        return json({ email: "e2e@example.com" });
      case "/v1internal:loadCodeAssist":
        return json({ cloudaicompanionProject: "e2e-project" });
      case "/v1internal:fetchUserInfo":
        return json({ userSettings: { email: "e2e@example.com" } });
      case "/v1internal:fetchAvailableModels":
        return json(antigravityFixture("fetch-available-models.sample.json"));
      case "/v1internal:retrieveUserQuotaSummary":
        return json(antigravityFixture("retrieve-user-quota-summary.sample.json"));
      case "/v1internal:streamGenerateContent":
        return this.generate(parsed);
      default:
        return new Response(`no replay for ${req.method} ${url.pathname}`, { status: 404 });
    }
  }

  /** cloudcode-pa stream: the P0-LIVE tool loop (first call, then the replay with the function response), a captured
   * 400 for gemini-3.7-flash-tiered, otherwise the plugin's sample stream. */
  private generate(envelope: Record<string, unknown>): Response {
    const request = envelope["request"] as { contents: { parts: Record<string, unknown>[] }[]; tools?: unknown };
    const hasResponse = request.contents.some((c) => c.parts.some((p) => p["functionResponse"] !== undefined));
    const pick =
      envelope["model"] === "gemini-3.7-flash-tiered"
        ? captured("e3/t4-f2-document.json")
        : hasResponse
          ? captured("t2-s2-tool-loop.json", 1)
          : request.tools !== undefined
            ? captured("t2-s2-tool-loop.json", 0)
            : { status: 200, contentType: "text/event-stream", body: antigravityFixture("stream-generate.sample.sse") };
    return new Response(pick.body, { status: pick.status, headers: { "content-type": pick.contentType } });
  }
}
