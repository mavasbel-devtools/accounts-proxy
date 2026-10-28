// The documentation stays in step with the code (plan 2026-10-16 C7, decision D2): the API reference, the OpenAPI
// document, the providers, format-fields, models and client-setup references state the routes, error codes and
// statuses, headers, commands, environment variables, limits and providers the code has. A change on either side that
// the other does not follow fails here, inside `bun run verify`. (The OpenAPI document is also checked against the real
// daemon by apps/proxy/tests/e2e/docs.test.ts.) The architecture diagram (docs/architecture.drawio, plan P7) names only
// declared code, states the code's constants and lock names, and its matrix page is the README's matrix.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RENEWAL_RETRY_AFTER_MS, TOKEN_ENDPOINT_TIMEOUT_MS } from "@accounts-proxy/core/domain/accounts.ts";
import { DEFAULT_MODEL_LIST_MAX_AGE_MINUTES, DEFAULT_PORT } from "@accounts-proxy/core/domain/config.ts";
import {
  InternalError,
  InvalidRequestError,
  PayloadTooLargeError,
  ProviderAuthRequiredError,
  ProviderDisabledError,
  QuotaExhaustedError,
  RouteNotFoundError,
  UnauthorizedError,
  UnknownAccountError,
  UnknownModelError,
  UnsupportedFeatureError,
  UpstreamError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
  type ProxyError,
  type ProxyErrorCode,
} from "@accounts-proxy/core/domain/errors.ts";
import { PROVIDER_IDS } from "@accounts-proxy/core/domain/models.ts";
import { MODEL_REFRESH_PATH } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { rpcStatusFor } from "@accounts-proxy/core/domain/services/google-error.ts";
import { DROPPED_HEADER, UPSTREAM_IDLE_TIMEOUT_MS } from "@accounts-proxy/core/domain/wire.ts";
import { AnthropicCodec, anthropicErrorType } from "@accounts-proxy/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@accounts-proxy/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@accounts-proxy/dialect-openai/adapters/inbound/openai-codec.ts";
import { REFRESH_LOCK as ANTIGRAVITY_REFRESH_LOCK } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-session.ts";
import { EXPIRY_BUFFER_MS as ANTIGRAVITY_EXPIRY_BUFFER_MS } from "@accounts-proxy/provider-antigravity/domain/constants.ts";
import { REFRESH_LOCK as CLAUDE_REFRESH_LOCK } from "@accounts-proxy/provider-claude/adapters/outbound/claude-session.ts";
import { NATIVE_PATHS as CLAUDE_NATIVE_PATHS } from "@accounts-proxy/provider-claude/adapters/outbound/claude-subscription-provider.ts";
import { EXPIRY_BUFFER_MS as CLAUDE_EXPIRY_BUFFER_MS } from "@accounts-proxy/provider-claude/domain/constants.ts";
import { NATIVE_PATH as OPENAI_NATIVE_PATH } from "@accounts-proxy/provider-openai/adapters/outbound/openai-provider.ts";
import { REFRESH_LOCK as OPENAI_REFRESH_LOCK } from "@accounts-proxy/provider-openai/adapters/outbound/openai-session.ts";
import { EXPIRY_BUFFER_MS as OPENAI_EXPIRY_BUFFER_MS } from "@accounts-proxy/provider-openai/domain/constants.ts";
import { EXPIRY_BUFFER_MS as OPENCODE_EXPIRY_BUFFER_MS, REFRESH_LOCK as OPENCODE_REFRESH_LOCK } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-session.ts";
import { SHUTDOWN_GRACE_MS } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/daemon-commands.ts";
import { DEFAULT_LOGIN_TIMEOUT_S } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/login-command.ts";
import { PROXY_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/proxy-commands.ts";
import { synopses as helpSynopses } from "@accounts-proxy/proxy/adapters/inbound/cli/help-text.ts";
import { MAX_BODY_BYTES } from "@accounts-proxy/proxy/adapters/inbound/http/node-http-server.ts";
import { DETAILED_MODELS_PATH, LOSSY_HEADER, MODELS_SOURCE_HEADER, OPENCODE_CONFIG_PATH, WELL_KNOWN_PATH } from "@accounts-proxy/proxy/adapters/inbound/http/route-handler.ts";
import { DEFAULT_LOCK_OPTIONS } from "@accounts-proxy/proxy/adapters/outbound/file-lock.ts";
import { ACCOUNTS_LOCK } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";
import { STATUS_TIMEOUT_MS } from "@accounts-proxy/proxy/application/daemon-status-service.ts";
import { REFRESH_TIMEOUT_MS } from "@accounts-proxy/proxy/application/request-model-refresh-service.ts";

const repo = join(import.meta.dir, "..", "..", "..", "..");
const REFERENCE = join(repo, "docs", "reference");
const DOCS = {
  api: "2026-10-17-19-26-proxy-api.md",
  openapi: "2026-10-17-19-26-proxy-openapi.json",
  providers: "2026-10-17-19-26-providers.md",
  formats: "2026-10-17-19-26-format-fields.md",
  models: "2026-10-17-19-26-models.md",
  clients: "2026-10-17-19-26-client-setup.md",
} as const;
const read = (name: string) => readFileSync(join(REFERENCE, name), "utf8");
const api = read(DOCS.api);
type Operation = { operationId: string; responses: Record<string, unknown> };
type OpenApi = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, { enum?: unknown[]; properties?: Record<string, unknown> }> } };
const openapi = JSON.parse(read(DOCS.openapi)) as OpenApi;

/** One instance of every proxy error (the Record type makes the compiler demand every code). */
const ERRORS: Readonly<Record<ProxyErrorCode, ProxyError>> = {
  invalid_request: new InvalidRequestError("x"),
  unsupported_feature: new UnsupportedFeatureError(["x"], "y"),
  unauthorized: new UnauthorizedError(),
  unknown_model: new UnknownModelError("x"),
  unknown_account: new UnknownAccountError("claude", "x"),
  not_found: new RouteNotFoundError("GET", "/x"),
  payload_too_large: new PayloadTooLargeError(1),
  provider_auth_required: new ProviderAuthRequiredError("claude", "x"),
  provider_disabled: new ProviderDisabledError("claude"),
  quota_exhausted: new QuotaExhaustedError("antigravity", "x"),
  upstream_timeout: new UpstreamTimeoutError("h", 1),
  upstream_unreachable: new UpstreamUnreachableError("h", "x"),
  upstream_error: new UpstreamError("antigravity", 502, "x"),
  internal_error: new InternalError(),
};

/** Every operation the route handler serves, from the code's own constants (method and OpenAPI path). */
function codeOperations(): string[] {
  const anthropic = new AnthropicCodec().prefix;
  const openai = new OpenAiCodec().prefix;
  const gemini = new GeminiCodec().prefix;
  const geminiMethods = ["generateContent", "streamGenerateContent", "countTokens"];
  return [
    "GET /health",
    `GET ${WELL_KNOWN_PATH}`,
    `GET ${OPENCODE_CONFIG_PATH}`,
    `GET ${DETAILED_MODELS_PATH}`,
    `POST ${MODEL_REFRESH_PATH}`,
    ...Object.keys(CLAUDE_NATIVE_PATHS).map((p) => `POST ${anthropic}${p}`),
    `GET ${anthropic}/v1/models`,
    `POST ${openai}/v1/chat/completions`,
    `POST ${openai}${OPENAI_NATIVE_PATH}`,
    `GET ${openai}/v1/models`,
    ...geminiMethods.map((m) => `POST ${gemini}/v1beta/models/{model}:${m}`),
    `GET ${gemini}/v1beta/models`,
  ].sort();
}

const specOperations = (): string[] =>
  Object.entries(openapi.paths)
    .flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();

describe("the documentation is in step with the code", () => {
  test("routes: the OpenAPI operations are the route handler's, and the API reference lists each", () => {
    expect(specOperations()).toEqual(codeOperations());
    for (const operation of codeOperations()) expect(api).toContain(`| \`${operation}`);
  });

  test("errors: every code with its status in the API reference and the OpenAPI enum", () => {
    expect(openapi.components.schemas["ErrorCode"]!.enum).toEqual(Object.keys(ERRORS));
    for (const [code, error] of Object.entries(ERRORS)) {
      expect(error.code).toBe(code as ProxyErrorCode);
      const status = code === "upstream_error" ? "the provider's status, else 502" : String(error.httpStatus);
      expect(api).toContain(`| ${status} | \`${code}\` |`);
    }
  });

  test("error shapes: the Anthropic types and google.rpc names the codecs give each status", () => {
    const anthropicTypes = openapi.components.schemas["AnthropicError"]!.properties!["error"] as { properties: { type: { enum: string[] } } };
    for (const status of [400, 401, 402, 403, 404, 409, 413, 429, 500, 504, 529]) {
      expect(api).toContain(`${status} \`${anthropicErrorType(status)}\``);
      expect(anthropicTypes.properties.type.enum).toContain(anthropicErrorType(status));
    }
    for (const error of Object.values(ERRORS)) expect(anthropicTypes.properties.type.enum).toContain(anthropicErrorType(error.httpStatus));
    expect(api).toContain(`any other status \`${anthropicErrorType(418)}\``);
    for (const status of [400, 401, 403, 404, 409, 429, 499, 500, 501, 503, 504]) expect(api).toContain(`${status} \`${rpcStatusFor(status)}\``);
    expect(api).toContain(`any other \`${rpcStatusFor(418)}\``);
  });

  test("headers: the proxy's headers in the API reference and the OpenAPI document", () => {
    const spec = JSON.stringify(openapi);
    for (const header of [LOSSY_HEADER, DROPPED_HEADER, MODELS_SOURCE_HEADER]) {
      expect(api).toContain(`| \`${header}`);
      expect(spec).toContain(`"${header}"`);
    }
  });

  test("command line: every synopsis of the command tree is a row of the API reference", () => {
    const synopses = helpSynopses(PROXY_HELP);
    expect(synopses).toEqual(["login <provider> [--manual] [--new] [--key] [--from-opencode] [--timeout-seconds N]", "account list <provider>", "account use <provider> <account-id>", "account remove <provider> <account-id>", "quota <provider>", "models [<provider>] [--json] [--refresh]", "opencode-config", "serve", "token", "status", "help [<command> [<subcommand>]]"]);
    for (const synopsis of synopses) expect(api).toContain(`| \`${synopsis}\` |`);
  });

  test("environment: every ACCOUNTS_PROXY_* name in the sources is in the API reference", () => {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) for (const match of readFileSync(full, "utf8").matchAll(/ACCOUNTS_PROXY_[A-Z_]*[A-Z](?![A-Z_])/g)) names.add(match[0]);
      }
    };
    for (const root of ["apps", "packages"]) for (const workspace of readdirSync(join(repo, root))) walk(join(repo, root, workspace, "src"));
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(api).toContain(`\`${name}\``);
  });

  test("limits and timers: the values the API reference states are the code's", () => {
    expect(api).toContain(`request body: ${MAX_BODY_BYTES} bytes`);
    expect(api).toContain(`over ${MAX_BODY_BYTES} bytes`);
    expect(api).toContain(`upstream idle timeout: ${UPSTREAM_IDLE_TIMEOUT_MS} ms`);
    expect(api).toContain(`for ${UPSTREAM_IDLE_TIMEOUT_MS} ms (10 minutes)`);
    expect(UPSTREAM_IDLE_TIMEOUT_MS).toBe(10 * 60_000);
    expect(api).toContain(`shutdown grace: ${SHUTDOWN_GRACE_MS} ms`);
    expect(api).toContain(`get ${SHUTDOWN_GRACE_MS} ms (10 s)`);
    expect(api).toContain(`login wait: ${DEFAULT_LOGIN_TIMEOUT_S} s`);
    expect(api).toContain(`up to ${DEFAULT_LOGIN_TIMEOUT_S} s by default`);
    expect(api).toContain(`default \`${DEFAULT_PORT}\``);
    expect(api).toContain(`with a ${STATUS_TIMEOUT_MS} ms deadline`);
    for (const buffer of [CLAUDE_EXPIRY_BUFFER_MS, ANTIGRAVITY_EXPIRY_BUFFER_MS, OPENAI_EXPIRY_BUFFER_MS, OPENCODE_EXPIRY_BUFFER_MS]) expect(buffer).toBe(2 * 60_000);
    expect(api).toContain("access-token renewal: 2 minutes before expiry");
    expect([TOKEN_ENDPOINT_TIMEOUT_MS, RENEWAL_RETRY_AFTER_MS]).toEqual([30_000, 30_000]);
    expect(api).toContain("bounded by 30 s; a transient renewal failure keeps a still-valid token and retries after 30 s");
    expect(DEFAULT_MODEL_LIST_MAX_AGE_MINUTES).toBe(24 * 60);
    expect(api).toContain(`model lists and the reference catalog: \`modelListMaxAgeMinutes\`, default ${DEFAULT_MODEL_LIST_MAX_AGE_MINUTES} minutes (24 h)`);
    expect(api).toContain(`| \`modelListMaxAgeMinutes\` | positive integer; default ${DEFAULT_MODEL_LIST_MAX_AGE_MINUTES}`);
    expect(api).toContain(`model refresh: ${REFRESH_TIMEOUT_MS} ms`);
  });

  test("providers: a section for each in the providers, models and format-fields references", () => {
    const providers = read(DOCS.providers);
    const models = read(DOCS.models);
    const formats = read(DOCS.formats);
    expect([...providers.matchAll(/^## .+$/gm)].map((m) => m[0])).toEqual(PROVIDER_IDS.map((id) => `## ${id}`));
    expect([...models.matchAll(/^## .+$/gm)].map((m) => m[0])).toEqual(PROVIDER_IDS.map((id) => `## ${id}`));
    for (const id of PROVIDER_IDS) {
      expect(providers).toContain(`| [\`${id}\`](#${id}) |`);
      expect(formats).toContain(`\`${id}\``);
      expect(api).toContain(`\`${id}\``);
    }
    expect(openapi.components.schemas["ProviderId"]!.enum).toEqual([...PROVIDER_IDS]);
  });

  test("the README links every reference document", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    for (const name of Object.values(DOCS)) expect(readme).toContain(`(docs/reference/${name})`);
  });

  test("the OpenAPI document: every $ref resolves", () => {
    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/components\/([a-zA-Z]+)\/([A-Za-z]+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    const components = openapi.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs) expect([kind, name, components[kind!]?.[name!] !== undefined]).toEqual([kind, name, true]);
  });
});

/** The diagram's pages: name → the decoded text of every cell (vertex and edge labels). */
function diagramPages(): Map<string, { cells: Map<string, string> }> {
  const xml = readFileSync(join(repo, "docs", "architecture.drawio"), "utf8");
  const decode = (text: string) => text.replaceAll("&#10;", "\n").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
  const pages = new Map<string, { cells: Map<string, string> }>();
  for (const page of xml.matchAll(/<diagram id="[^"]+" name="([^"]+)">([\s\S]*?)<\/diagram>/g)) {
    const cells = new Map<string, string>();
    for (const cell of page[2]!.matchAll(/<mxCell id="([^"]+)" value="([^"]*)"/g)) cells.set(cell[1]!, decode(cell[2]!));
    pages.set(decode(page[1]!), { cells });
  }
  return pages;
}

/** Every top-level declaration name of the workspaces' sources. */
function declaredNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) for (const m of readFileSync(path, "utf8").matchAll(/\b(?:class|type|interface|function|const|enum) ([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!);
    }
  };
  for (const root of ["apps", "packages"]) for (const workspace of readdirSync(join(repo, root))) walk(join(repo, root, workspace, "src"));
  return names;
}

/** Product names on the diagram that are not code. */
const PRODUCT_NAMES = new Set(["ChatGPT", "GenAI", "OpenAI", "OpenCode"]);
const underscored = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");

describe("the architecture diagram is in step with the code", () => {
  const pages = diagramPages();
  const page = (prefix: string) => {
    const found = [...pages.entries()].find(([name]) => name.startsWith(prefix));
    expect(found).toBeDefined();
    return [...found![1].cells.values()].join("\n");
  };

  test("pages: components, request flow, renewal under locks, format × provider matrix", () => {
    expect([...pages.keys()].map((name) => name.replace(/ \(.*\)$/, ""))).toEqual(["Components", "Request flow", "Renewal under locks", "Format × provider matrix"]);
  });

  test("every code name on the diagram is declared in a source file", () => {
    const declared = declaredNames();
    const text = [...pages.values()].flatMap((p) => [...p.cells.values()]).join("\n");
    const named = new Set([...text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(100);
    const missing = [...named].filter((name) => !declared.has(name) && !PRODUCT_NAMES.has(name));
    expect(missing).toEqual([]);
  });

  test("every constant the diagram states has the code's value, and the lock names are the code's", () => {
    const constants: Readonly<Record<string, number>> = {
      MAX_BODY_BYTES,
      SHUTDOWN_GRACE_MS,
      UPSTREAM_IDLE_TIMEOUT_MS,
      EXPIRY_BUFFER_MS: CLAUDE_EXPIRY_BUFFER_MS,
      TOKEN_ENDPOINT_TIMEOUT_MS,
      RENEWAL_RETRY_AFTER_MS,
      staleMs: DEFAULT_LOCK_OPTIONS.staleMs,
      timeoutMs: DEFAULT_LOCK_OPTIONS.timeoutMs,
      pollMs: DEFAULT_LOCK_OPTIONS.pollMs,
    };
    for (const buffer of [ANTIGRAVITY_EXPIRY_BUFFER_MS, OPENAI_EXPIRY_BUFFER_MS, OPENCODE_EXPIRY_BUFFER_MS]) expect(buffer).toBe(CLAUDE_EXPIRY_BUFFER_MS);
    const text = [...pages.values()].flatMap((p) => [...p.cells.values()]).join("\n");
    const stated = [...text.matchAll(/\b([A-Za-z_]+) = ([0-9_]+)\b/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(stated.length).toBe(Object.keys(constants).length);
    for (const [name, value] of stated) expect([name, value]).toEqual([name, underscored(constants[name]!)]);
    const renewal = page("Renewal under locks");
    for (const lock of [CLAUDE_REFRESH_LOCK, ANTIGRAVITY_REFRESH_LOCK, OPENAI_REFRESH_LOCK, OPENCODE_REFRESH_LOCK]) expect(renewal).toContain(lock);
    expect(renewal).toContain(`→ ${ACCOUNTS_LOCK},`);
    expect(renewal).toContain(`under the lock ${ACCOUNTS_LOCK} `);
  });

  test("the matrix page is the README's format × provider matrix", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Format × provider matrix"));
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.startsWith("|---"))
      .slice(0, 5)
      .map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));
    const cells = [...pages.entries()].find(([name]) => name.startsWith("Format × provider matrix"))![1].cells;
    const drawn = rows.map((row, r) => row.map((_, c) => cells.get(`m-r${r}-c${c}`)));
    expect(rows.length).toBe(5);
    expect(drawn).toEqual(rows);
  });
});

describe("client setup §3 cites the pinned SDKs' own environment reads", () => {
  const clients = read(DOCS.clients);
  const modules = join(repo, "apps", "proxy", "node_modules");
  const reads: readonly { file: string; cite: string; line: number; names: readonly string[] }[] = [
    { file: "@anthropic-ai/sdk/client.mjs", cite: "`client.mjs:71`", line: 71, names: ["ANTHROPIC_BASE_URL"] },
    { file: "@anthropic-ai/sdk/client.mjs", cite: "`:78`", line: 78, names: ["ANTHROPIC_API_KEY"] },
    { file: "@anthropic-ai/sdk/client.mjs", cite: "`:81`", line: 81, names: ["ANTHROPIC_AUTH_TOKEN"] },
    { file: "openai/client.mjs", cite: "`client.mjs:180`", line: 180, names: ["OPENAI_BASE_URL", "OPENAI_API_KEY"] },
    { file: "@google/genai/dist/node/index.mjs", cite: "`dist/node/index.mjs:27615`", line: 27615, names: ["GOOGLE_GEMINI_BASE_URL"] },
    { file: "@google/genai/dist/node/index.mjs", cite: "`:27665–27668`", line: 27665, names: ["GOOGLE_API_KEY"] },
    { file: "@google/genai/dist/node/index.mjs", cite: "`:27665–27668`", line: 27666, names: ["GEMINI_API_KEY"] },
  ];

  test("each cited line reads the variable the document names", () => {
    for (const { file, cite, line, names } of reads) {
      const source = readFileSync(join(modules, file), "utf8").split("\n")[line - 1]!;
      expect(clients).toContain(cite);
      for (const name of names) {
        expect([file, line, name, source.includes(`'${name}'`)]).toEqual([file, line, name, true]);
        expect(clients).toContain(`\`${name}=`);
      }
    }
  });
});
