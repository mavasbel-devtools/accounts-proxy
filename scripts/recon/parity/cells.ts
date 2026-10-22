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
  /** The upstream path of the proxy's counterpart request. */
  readonly upstreamPath: string;
  /** Plain-language statement of what the mapping changes, printed in every report. */
  readonly mapping: string;
  readonly input: (captured: WireRequest, token: string) => ProxyInput;
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
};

export const CELLS: Readonly<Record<string, Cell>> = { claude, antigravity };

export function cellFor(client: string): Cell {
  const cell = CELLS[client];
  if (cell === undefined) throw new Error(`no parity cell for ${client}; known: ${Object.keys(CELLS).join(", ")}`);
  return cell;
}
