// How one captured client request becomes the request that client would send to the proxy, and which upstream
// request of the proxy is its counterpart. One entry per reference client whose inference the proxy carries.
import type { WireRequest } from "@accounts-proxy/scripts/recon/parity/canon.ts";

export type ProxyInput = {
  /** Path and query on the proxy. */
  readonly target: string;
  /** Headers in the client's order; the proxy token is carried the way that client would carry it. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
};

export type Cell = {
  readonly client: string;
  /** The upstream path of the proxy's counterpart request (described in reports). */
  readonly upstreamPath: string;
  /**
   * Whether a request the proxy sent upstream is the counterpart of the captured one; absent: its path equals
   * `upstreamPath`. A cell whose client uses several endpoints matches by family, so a wrong path is a reported gap.
   */
  readonly isCounterpart?: (path: string) => boolean;
  /** Plain-language statement of what the mapping changes, printed in every report. */
  readonly mapping: string;
  readonly input: (captured: WireRequest, token: string) => ProxyInput;
  /** What the signed-in parity daemon needs beyond its Claude and Antigravity sign-ins. */
  readonly daemon?: {
    /** `providers:` entries appended to the daemon's proxy.yaml. */
    readonly providers: string;
    /** Provider pools written to the daemon's accounts file before it starts (a test account, never a real one). */
    readonly pools: Readonly<Record<string, unknown>>;
  };
  /** Transport residual headers or ordering differences precluded by runtime language difference (Go vs Bun). */
  readonly ignoreHeaders?: ReadonlySet<string>;
};

/** Headers that belong to the hop to the provider, not to what the client would send to the proxy. */
const HOP = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]);

function parse(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

const claude: Cell = {
  client: "claude",
  upstreamPath: "/v1/messages",
  mapping:
    "Claude Code pointed at the proxy (`ANTHROPIC_BASE_URL`) sends the same request to `/anthropic/v1/messages`: the " +
    "captured headers in their order with the proxy token in `Authorization`, and the captured body with the model " +
    "named `claude/<model>`. Hop headers (`host`, `content-length`, `connection`, `accept-encoding`) are left to the " +
    "HTTP stack.",
  input(captured, token) {
    const url = new URL(captured.url);
    const body = parse(captured.body);
    return {
      target: `/anthropic${url.pathname}${url.search}`,
      headers: captured.headers
        .filter(([name]) => !HOP.has(name.toLowerCase()))
        .map(([name, value]) => (name.toLowerCase() === "authorization" ? ([name, `Bearer ${token}`] as const) : ([name, value] as const))),
      body: JSON.stringify({ ...body, model: `claude/${String(body["model"])}` }),
    };
  },
};

const antigravity: Cell = {
  client: "antigravity",
  upstreamPath: "/v1internal:streamGenerateContent",
  mapping:
    "Antigravity speaks the Cloud Code envelope itself; a Gemini client of the proxy sends only the inner request. The " +
    "input is the captured `request` without its envelope-only fields `sessionId` and `labels`, posted to " +
    "`/gemini/v1beta/models/antigravity%2F<model>:streamGenerateContent?alt=sse` with the token in `x-goog-api-key`. " +
    "Everything the proxy then adds — envelope, labels, session, headers — is compared with what Antigravity sent.",
  input(captured, token) {
    const envelope = parse(captured.body);
    const { sessionId: _session, labels: _labels, ...inner } = envelope["request"] as Record<string, unknown>;
    return {
      target: `/gemini/v1beta/models/antigravity%2F${encodeURIComponent(String(envelope["model"]))}:streamGenerateContent?alt=sse`,
      headers: [
        ["content-type", "application/json"],
        ["x-goog-api-key", token],
      ],
      body: JSON.stringify(inner),
    };
  },
  ignoreHeaders: new Set(["transfer-encoding", "connection", "accept", "content-length", "header-order"]),
};

/** OpenCode's own request headers that a client of the proxy sends it too; the workspace header is the proxy's. */
const OPENCODE_WORKSPACE_HEADER = "x-opencode-org-id";
/** OpenCode's credential header per endpoint family (captured: Bearer on Chat, Responses and Messages; Gemini's key). */
const OPENCODE_KEY_HEADERS = new Set(["authorization", "x-goog-api-key"]);

/** The proxy route and model name for one captured OpenCode inference URL (Zen or Go, four families). */
function opencodeTarget(url: URL, body: Record<string, unknown>): { readonly target: string; readonly body: Record<string, unknown> } {
  const provider = url.pathname.startsWith("/inference/go/") ? "opencode-go" : "opencode";
  const gemini = /\/google\/v1beta\/models\/([^/:]+):([A-Za-z]+)$/.exec(url.pathname);
  if (gemini !== null) {
    return { target: `/gemini/v1beta/models/${encodeURIComponent(`${provider}/${decodeURIComponent(gemini[1]!)}`)}:${gemini[2]!}${url.search}`, body };
  }
  const family = /\/(openai\/v1\/chat\/completions|openai\/v1\/responses|anthropic\/v1\/messages)$/.exec(url.pathname)?.[1];
  if (family === undefined) throw new Error(`no proxy route for the OpenCode request ${url.pathname}`);
  const prefix = family.startsWith("anthropic/") ? "/anthropic" : "/openai";
  return { target: `${prefix}/${family.slice(family.indexOf("/") + 1)}`, body: { ...body, model: `${provider}/${String(body["model"])}` } };
}

const opencode: Cell = {
  client: "opencode",
  upstreamPath: "/inference/…",
  isCounterpart: (path) => path.startsWith("/inference/") && !path.endsWith("/models"),
  mapping:
    "OpenCode with a provider pointed at the proxy sends the same request to the proxy's route for its format " +
    "(`/openai/v1/chat/completions`, `/openai/v1/responses`, `/anthropic/v1/messages`, `/gemini/v1beta/models/<model>:…`) " +
    "with the model named `opencode/<model>` or `opencode-go/<model>`: the captured headers with the proxy token in the " +
    "captured credential header (`Authorization` or `x-goog-api-key`), without the workspace header `x-opencode-org-id` " +
    "(OpenCode adds it only on its own Console providers; the proxy adds the signed-in workspace's) and without the hop " +
    "headers (`Connection`, `Accept: */*`, `Host`, `Accept-Encoding`, `Content-Length`), which Bun's HTTP stack sets on " +
    "both sides. The proxy is signed in to a Console workspace whose config names `x-opencode-org-id`.",
  daemon: {
    providers: "  opencode: {enabled: true}\n  opencode-go: {enabled: true}\n",
    pools: {
      opencode: {
        activeId: "parity/workspace",
        accounts: [
          {
            provider: "opencode",
            id: "parity/workspace",
            label: "parity",
            data: {
              accessToken: "parity-console-access",
              refreshToken: "parity-console-refresh",
              expiresAt: 4_102_444_800_000,
              orgId: "wrk_01PARITYPARITYPARITYPARITY",
              workspaceHeaders: { opencode: { "x-opencode-org-id": "wrk_01PARITYPARITYPARITYPARITY" }, "opencode-go": { "x-opencode-org-id": "wrk_01PARITYPARITYPARITYPARITY" } },
            },
          },
        ],
      },
    },
  },
  input(captured, token) {
    const url = new URL(captured.url);
    const mapped = opencodeTarget(url, parse(captured.body));
    return {
      target: mapped.target,
      headers: captured.headers
        .filter(([name]) => !HOP.has(name.toLowerCase()) && name.toLowerCase() !== OPENCODE_WORKSPACE_HEADER && name.toLowerCase() !== "accept")
        .map(([name, value]) => {
          if (!OPENCODE_KEY_HEADERS.has(name.toLowerCase())) return [name, value] as const;
          return [name, name.toLowerCase() === "authorization" ? `Bearer ${token}` : token] as const;
        }),
      body: JSON.stringify(mapped.body),
    };
  },
};

/**
 * opencode's ChatGPT provider compresses the body only toward its own default `baseURL` (opencode v2.1.1
 * `encoding: settings.encoding ?? "zstd"` when `baseURL` is unset); a provider pointed at the proxy sets one, so it
 * sends the decoded body without `Content-Encoding`.
 */
const OPENAI_CLIENT_DROPPED = new Set([...HOP, "accept", "content-encoding"]);

const openai: Cell = {
  client: "opencode",
  upstreamPath: "/v1/responses",
  mapping:
    "OpenCode with a provider pointed at the proxy sends the same Responses request to `/openai/v1/responses` with the " +
    "model named `openai/<model>`: the captured headers in their order with the proxy token in `Authorization`, the " +
    "decoded body, and no `Content-Encoding` (opencode compresses only toward its own default address) and without the " +
    "hop headers (`Connection`, `Accept: */*`, `Host`, `Accept-Encoding`, `Content-Length`), which Bun's HTTP stack sets " +
    "on both sides. The proxy is signed in to a test ChatGPT account.",
  daemon: {
    providers: "  openai: {enabled: true, acknowledgeTermsRisk: true}\n",
    pools: {
      openai: {
        activeId: "parity-client",
        accounts: [
          {
            provider: "openai",
            id: "parity-client",
            label: "parity",
            data: {
              accessToken: "parity-openai-access",
              refreshToken: "parity-openai-refresh",
              expiresAt: 4_102_444_800_000,
              scopes: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
              clientId: "parity-client",
              subject: "parity-subject",
              idToken: "parity-id-token",
            },
          },
        ],
      },
    },
  },
  input(captured, token) {
    const body = parse(captured.body);
    return {
      target: "/openai/v1/responses",
      headers: captured.headers
        .filter(([name]) => !OPENAI_CLIENT_DROPPED.has(name.toLowerCase()))
        .map(([name, value]) => (name.toLowerCase() === "authorization" ? ([name, `Bearer ${token}`] as const) : ([name, value] as const))),
      body: JSON.stringify({ ...body, model: `openai/${String(body["model"])}` }),
    };
  },
};

/** The cell of one captured request: by client, and for opencode by the upstream it called. */
export function cellOf(client: string, url: string): Cell {
  if (client === "opencode" && new URL(url).host === "api.openai.com") return openai;
  return cellFor(client);
}

export const CELLS: Readonly<Record<string, Cell>> = { claude, antigravity, opencode };

export function cellFor(client: string): Cell {
  const cell = CELLS[client];
  if (cell === undefined) throw new Error(`no parity cell for ${client}; known: ${Object.keys(CELLS).join(", ")}`);
  return cell;
}
