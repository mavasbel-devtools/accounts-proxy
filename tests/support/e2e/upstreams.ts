// One loopback replay server standing in for every upstream host the daemon talks to; the composition root's
// ACCOUNTS_PROXY_TEST_UPSTREAM_* seams point all four origins here (paths are the production paths). Every response
// body is a committed capture: the source plugins' fixtures (plugin-6292741, plugin-5c6f7c2) or the proxy's own
// redacted P0-LIVE captures (E2/E3 streams, E5 control plane: live catalog, quota, loadCodeAssist, fetchUserInfo), and
// the gateways' public model lists fetched into docs/reference/specs (plan P4.6), OpenRouter's documented OpenAPI examples
// (key exchange, key info, Chat / Responses / Messages answers), the captured OpenCode gateway refusal (probe z0), and
// the OpenCode Console's captured answers (amendment A probes c0–c3) and documented config example.
// Google's userinfo answer (`{email}`, the documented shape) is the one synthetic body: no capture exists. Non-streamed Claude messages are assembled from a captured stream's events (no
// non-streamed capture exists); count_tokens answers the P6 probe's captures (p6/c1 refusal, p6/c2 count).
// OpenAI (live validation L4): the live model list (l4/openai-models) for an e2e access token, the live Responses streams
// (L1 openai-resp-*), and the key set of the replay's signing key (openai-signing.ts; OpenAI's own private key cannot sign).
// Every request is recorded so tests can assert what the daemon really sent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jwks } from "@accounts-proxy/test-support/e2e/openai-signing.ts";

export type Recorded = { readonly method: string; readonly path: string; readonly search: string; readonly headers: Record<string, string>; readonly body: string };

const repo = join(import.meta.dir, "..", "..", "..");
/** P4.6: the gateways' public model lists as fetched into docs/reference/specs (provenance in manifest.json). */
export const spec = (name: string) => readFileSync(join(repo, "docs", "reference", "specs", name), "utf8");
type OpenApi = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { example?: unknown }> }> }>> };
let openRouterApi: OpenApi | undefined;
/** P4.6: an example of OpenRouter's OpenAPI document (`openrouter-openapi.yaml`), the documented answer of one operation. */
export function openRouterExample(path: string, method: "get" | "post", status: string, contentType: string): unknown {
  openRouterApi ??= Bun.YAML.parse(spec("openrouter-openapi.yaml")) as OpenApi;
  return openRouterApi.paths[path]![method]!.responses[status]!.content![contentType]!.example;
}
/**
 * P4.6 amendment A: the workspace-config example of the OpenCode Console API page (`opencode-console-api.html`,
 * "Workspace config"), read from the page's text.
 */
export function consoleConfigExample(): unknown {
  const text = spec("opencode-console-api.html")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
  const start = /\{\s*"providers"/.exec(text)!.index;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (text[i] === "{") depth += 1;
    if (text[i] === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("no config example in opencode-console-api.html");
}
/** The documented SSE example (one event) as a stream frame. */
function openRouterStream(path: string): string {
  const frame = openRouterExample(path, "post", "200", "text/event-stream") as { event?: string; data: unknown };
  return `${frame.event !== undefined ? `event: ${frame.event}\n` : ""}data: ${JSON.stringify(frame.data)}\n\n`;
}
const claudeFixture = (name: string) => readFileSync(join(repo, "packages", "provider-claude", "tests", "fixtures", "plugin-6292741", name), "utf8");
const recon21304Fixture = (name: string) => readFileSync(join(repo, "packages", "provider-claude", "tests", "fixtures", "recon-2.1.304", name), "utf8");
const antigravityFixture = (name: string) => readFileSync(join(repo, "packages", "provider-antigravity", "tests", "fixtures", "plugin-5c6f7c2", name), "utf8");
type Capture = { exchanges: { response: { status: number; headers: Record<string, string>; chunks: { text: string }[] } }[] };
const capture = (relative: string): Capture => JSON.parse(readFileSync(join(repo, "tests", "fixtures", "captures", "p0-live", relative), "utf8")) as Capture;
/** The body parameters of count_tokens (anthropic-count-tokens.md "Body parameters"). */
const COUNT_TOKENS_FIELDS = ["messages", "model", "cache_control", "output_config", "system", "thinking", "tool_choice", "tools"];

export const captured = (relative: string, index = 0) => {
  const exchange = capture(relative).exchanges[index]!.response;
  return { status: exchange.status, contentType: exchange.headers["content-type"] ?? "text/event-stream", body: exchange.chunks.map((c) => c.text).join("") };
};

/**
 * A captured ChatGPT plan-usage answer with the headers it had: its `content-type` only when it sent one (its streams
 * carry none, rule I7) and its `x-oai-request-id`. A stream body, so the replay server adds no content type of its own.
 */
function openaiCapture(relative: string, index = 0): Response {
  const exchange = capture(relative).exchanges[index]!.response;
  const headers: Record<string, string> = { "x-oai-request-id": exchange.headers["x-oai-request-id"]! };
  if (exchange.headers["content-type"] !== undefined) headers["content-type"] = exchange.headers["content-type"];
  const bytes = new TextEncoder().encode(exchange.chunks.map((c) => c.text).join(""));
  const body = new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(bytes), controller.close()) });
  return new Response(body, { status: exchange.status, headers });
}

/** A captured OpenCode Console answer with its status, content type and request id. */
function consoleCapture(relative: string, index = 0): Response {
  const answer = captured(relative, index);
  const logId = capture(relative).exchanges[index]!.response.headers["x-opencode-log-id"];
  return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType, ...(logId !== undefined ? { "x-opencode-log-id": logId } : {}) } });
}

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

/** A scripted answer for one request (receives the parsed JSON body, `{}` when it is not JSON). */
export type Responder = (body: Record<string, unknown>, request: Recorded) => Response | Promise<Response>;

export class ReplayUpstreams {
  readonly requests: Recorded[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly scripted = new Map<string, Responder[]>();

  /** Queues one-shot answers for a path; they are used in order before the default replay. */
  script(path: string, ...responders: Responder[]): this {
    this.scripted.set(path, [...(this.scripted.get(path) ?? []), ...responders]);
    return this;
  }

  /** Drops every queued answer (between tests). */
  reset(): void {
    this.scripted.clear();
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  /** The seam variables pointing every provider host at this server. */
  seamEnv(): Record<string, string> {
    return {
      ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_GOOGLE_OAUTH: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_API: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_AUTH: this.origin,
      ACCOUNTS_PROXY_TEST_UPSTREAM_GATEWAYS: this.origin,
    };
  }

  start(): this {
    // No server-side idle limit (Bun's default is 10 s): a scripted answer may stay silent longer than that.
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => this.answer(req) });
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

    const queued = this.scripted.get(url.pathname)?.shift();
    if (queued !== undefined) return queued(parsed, this.requests.at(-1)!);
    // OpenCode Console inference (amendment A): the Console's captured answers without an accepted credential (probe
    // c0/c1): Go without x-opencode-session, the free chat model, and each paid route. Probe Z26: a free model answers
    // only OpenCode's own User-Agent (f4), any other one gets the FreeTierError (c1, f5). The accepted shapes are the
    // probed ones: `opencode/latest/2.0.32/cli` (f1, f4) and `opencode/2.0.32` (f8) answered, `opencode/x` (f9) did not.
    if (req.method === "POST" && url.pathname === "/inference/openai/v1/chat/completions" && String(parsed["model"]).endsWith("-free")) {
      return consoleCapture(/^opencode\/(?:[^/]+\/)?\d+\.\d+/.test(headers["user-agent"] ?? "") ? "z26/f4-zen-client-agent.json" : "z26/f5-zen-no-agent.json");
    }
    if (req.method === "POST" && url.pathname.startsWith("/inference/")) {
      const name = url.pathname.startsWith("/inference/go/")
        ? headers["x-opencode-session"] === undefined
          ? "c0-go-chat"
          : "c0-openai-chat"
        : url.pathname.startsWith("/inference/google/")
          ? "c0-google"
          : url.pathname === "/inference/anthropic/v1/messages"
            ? "c0-anthropic-messages"
            : url.pathname === "/inference/openai/v1/responses"
              ? "c0-openai-responses"
              : parsed["model"] === "big-pickle"
                ? "c1-free-chat"
                : "c0-openai-chat";
      return consoleCapture(`console/${name}.json`);
    }
    const orInference = req.method === "POST" ? /^\/api\/v1(\/chat\/completions|\/responses|\/messages)$/.exec(url.pathname)?.[1] : undefined;
    if (orInference !== undefined) {
      const headers = { "x-generation-id": "gen-e2e" };
      return parsed["stream"] === true
        ? new Response(openRouterStream(orInference), { headers: { "content-type": "text/event-stream", ...headers } })
        : json(openRouterExample(orInference, "post", "200", "application/json"), 200, headers);
    }
    if (url.pathname.includes("/model_selector/cc")) {
      if (this.scripted.has("/v1/models") && (this.scripted.get("/v1/models")?.length ?? 0) > 0) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return json(recon21304Fixture("model-selector-response.json"));
    }
    switch (url.pathname) {
      case "/api/claude_code_penguin_mode":
        return json(recon21304Fixture("penguin-mode-response.json"));
      case "/api/claude_code_grove":
        return json(recon21304Fixture("grove-response.json"));
      case "/api/claude_cli/bootstrap":
        return json(recon21304Fixture("bootstrap-response.json"));
      case "/v1/oauth/token":
        return json(claudeFixture("refresh-response.json"));
      case "/v1/models":
        return headers["authorization"]?.startsWith("Bearer e2e-openai") ? json(captured("l4/openai-models.json").body) : json(claudeFixture("catalog-api-response.json"));
      case "/v1/responses": {
        const input = Array.isArray(parsed["input"]) ? (parsed["input"] as Record<string, unknown>[]) : [];
        const answer = input.some((i) => i["type"] === "function_call_output")
          ? openaiCapture("l1/openai-resp-s4-tool-loop.json", 1)
          : Array.isArray(parsed["tools"])
            ? openaiCapture("l1/openai-resp-s4-tool-loop.json", 0)
            : openaiCapture("l1/openai-resp-s2-plain-stream.json");
        return answer;
      }
      case "/.well-known/jwks.json":
        return json(jwks());
      case "/v1/messages/count_tokens": {
        // P6 probe: a body key outside the spec's body parameters is refused (the captured 400), else counted.
        const extra = Object.keys(parsed).some((key) => !COUNT_TOKENS_FIELDS.includes(key));
        const answer = captured(`p6/${extra ? "c1-without-max-tokens" : "c2-spec-fields"}.json`);
        return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.contentType, "request-id": "req_e2e" } });
      }
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
        return json(captured("e5/load-code-assist.json").body);
      case "/v1internal:fetchUserInfo":
        return json(captured("e5/fetch-user-info.json").body);
      case "/v1internal:fetchAvailableModels":
        return json(captured("e5/fetch-available-models.json").body);
      case "/v1internal:retrieveUserQuotaSummary":
        return json(captured("e5/retrieve-user-quota-summary.json").body);
      case "/v1internal:streamGenerateContent":
        return this.generate(parsed);
      case "/api/v1/models":
        return json(spec("openrouter-models.json"));
      case "/inference/v1/models":
        return json(spec("opencode-zen-models.json"));
      case "/inference/go/v1/models":
        return json(spec("opencode-go-models.json"));
      case "/console/auth/device/code":
        return consoleCapture("console/c2-device-flow.json", 0);
      case "/console/auth/device/token":
        return consoleCapture("console/c2-device-flow.json", 1);
      case "/console/api/v2/config":
        return headers["authorization"] === "Bearer oc_sk_refused" ? consoleCapture("console/c3-config-unauthenticated.json") : json(consoleConfigExample());
      // models.opencode.ai/api.json: the committed extract of the reference providers (plan 2026-10-16 C0).
      case "/api.json":
        return json(spec("models-opencode-reference.json"));
      case "/public/models":
        return json(spec("cheaper-inference-public-models.json"));
      case "/api/v1/auth/keys":
        return json(openRouterExample("/auth/keys", "post", "200", "application/json"));
      case "/api/v1/key":
        return json(openRouterExample("/key", "get", "200", "application/json"));
      default:
        return new Response(`no replay for ${req.method} ${url.pathname}`, { status: 404 });
    }
  }

  /** cloudcode-pa stream: the P0-LIVE tool loop (first call, then the replay with the function response), the captured
   * 400 of gpt-oss-120b-medium, otherwise the plugin's sample stream. */
  private generate(envelope: Record<string, unknown>): Response {
    const request = envelope["request"] as { contents: { parts: Record<string, unknown>[] }[]; tools?: unknown };
    const hasResponse = request.contents.some((c) => c.parts.some((p) => p["functionResponse"] !== undefined));
    const pick =
      envelope["model"] === "gpt-oss-120b-medium"
        ? captured("e3/t4-f2-document.json")
        : hasResponse
          ? captured("t2-s2-tool-loop.json", 1)
          : request.tools !== undefined
            ? captured("t2-s2-tool-loop.json", 0)
            : { status: 200, contentType: "text/event-stream", body: antigravityFixture("stream-generate.sample.sse") };
    return new Response(pick.body, { status: pick.status, headers: { "content-type": pick.contentType } });
  }
}

/** An SSE body from response objects, each framed as one `data:` event (the cloudcode-pa envelope shape). */
export function envelopeStream(...responses: unknown[]): Response {
  return new Response(responses.map((r) => `data: ${JSON.stringify({ response: r })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A JSON answer with a status. */
export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A streamed body that sends `first`, then fails the connection (a reset after the first byte). */
export function brokenStream(first: string, contentType = "text/event-stream"): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        setTimeout(() => controller.error(new Error("e2e: upstream connection reset")), 20);
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

/** A streamed body that sends `first` and then nothing until the client goes away. */
export function stalledStream(first: string, onCancel: () => void): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
