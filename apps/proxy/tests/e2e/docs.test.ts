// The reference documentation against the real proxy (plan 2026-10-16 C7, decision D2):
//   - the generated model reference equals a fresh generation (scripts/docs/models-reference.ts);
//   - every operation of the OpenAPI document is called on a real daemon (replayed upstreams, accounts signed in
//     through the fake browser), and each answer's status, body and documented headers match the document.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateModelsReference, MODELS_REFERENCE } from "@accounts-proxy/scripts/docs/models-reference.ts";
import { removeTemporary } from "@accounts-proxy/test-support/temporary.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";
import { startSignedInDaemon, type SignedInDaemon } from "@accounts-proxy/test-support/e2e/proxy-process.ts";
import { ReplayUpstreams } from "@accounts-proxy/test-support/e2e/upstreams.ts";

setDefaultTimeout(180_000);
const repo = join(import.meta.dir, "..", "..", "..", "..");
const OPENAPI = "docs/reference/2026-10-17-19-26-proxy-openapi.json";

type Schema = Record<string, unknown>;
type ResponseObject = { $ref?: string; headers?: Record<string, unknown>; content?: Record<string, { schema: Schema }> };
type Operation = { operationId: string; responses: Record<string, ResponseObject> };
type OpenApi = { paths: Record<string, Record<string, Operation>>; components: { responses: Record<string, ResponseObject> } };
const spec = JSON.parse(readFileSync(join(repo, OPENAPI), "utf8")) as OpenApi;

/** The operation of the document a request reaches (path templates: `{model}` is one path segment). */
function operationFor(method: string, path: string): Operation {
  for (const [template, item] of Object.entries(spec.paths)) {
    const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[a-z]+\}/g, "[^/]+")}$`);
    const operation = item[method.toLowerCase()];
    if (operation !== undefined && pattern.test(path)) return operation;
  }
  throw new Error(`no documented operation for ${method} ${path}`);
}

function responseFor(operation: Operation, status: number): ResponseObject {
  const declared = operation.responses[String(status)] ?? operation.responses["default"];
  if (declared === undefined) throw new Error(`${operation.operationId}: status ${status} is not documented`);
  return declared.$ref !== undefined ? spec.components.responses[declared.$ref.replace("#/components/responses/", "")]! : declared;
}

type Probe = { readonly method: "GET" | "POST"; readonly path: string; readonly token?: boolean; readonly body?: unknown; readonly status: number; readonly code?: string };

const anthropic = (model: string) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const contents = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
const PROBES: readonly Probe[] = [
  { method: "GET", path: "/health", token: false, status: 200 },
  { method: "GET", path: "/.well-known/opencode", token: false, status: 200 },
  { method: "GET", path: "/opencode/config.json", status: 200 },
  { method: "GET", path: "/opencode/config.json", token: false, status: 401, code: "unauthorized" },
  { method: "GET", path: "/.well-known/pi", token: false, status: 200 },
  { method: "GET", path: "/pi/models.json", status: 200 },
  { method: "GET", path: "/pi/models.json", token: false, status: 401, code: "unauthorized" },
  { method: "GET", path: "/proxy/v1/models", status: 200 },
  { method: "GET", path: "/proxy/v1/models?provider=claude", status: 200 },
  { method: "GET", path: "/proxy/v1/models?provider=nope", status: 400, code: "invalid_request" },
  { method: "POST", path: "/proxy/v1/models/refresh?provider=claude", status: 200 },
  { method: "POST", path: "/proxy/v1/models/refresh?provider=nope", status: 400, code: "invalid_request" },
  { method: "POST", path: "/proxy/v1/models/refresh?provider=openai", status: 503, code: "provider_disabled" },
  { method: "POST", path: "/proxy/v1/models/refresh", token: false, status: 401, code: "unauthorized" },
  { method: "GET", path: "/anthropic/v1/models", status: 200 },
  { method: "GET", path: "/anthropic/v1/models", token: false, status: 401, code: "unauthorized" },
  { method: "GET", path: "/openai/v1/models", status: 200 },
  { method: "GET", path: "/openai/v1/models", token: false, status: 401, code: "unauthorized" },
  { method: "GET", path: "/gemini/v1beta/models", status: 200 },
  { method: "GET", path: "/gemini/v1beta/models", token: false, status: 401, code: "unauthorized" },
  { method: "POST", path: "/anthropic/v1/messages", body: anthropic("antigravity/gemini-3.5-flash-lite"), status: 400, code: "unsupported_feature" },
  { method: "POST", path: "/anthropic/v1/messages", body: anthropic("nope"), status: 404, code: "unknown_model" },
  { method: "POST", path: "/anthropic/v1/messages/count_tokens", body: anthropic("openai/gpt-5.5"), status: 503, code: "provider_disabled" },
  { method: "POST", path: "/openai/v1/chat/completions", body: { model: "claude/claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hi" }] }, status: 400, code: "unsupported_feature" },
  { method: "POST", path: "/openai/v1/chat/completions", body: [], status: 400, code: "invalid_request" },
  { method: "POST", path: "/openai/v1/responses", body: { model: "nope", input: "hi" }, status: 404, code: "unknown_model" },
  { method: "POST", path: "/openai/v1/responses", body: { model: "openai/gpt-5.5", input: "hi" }, status: 503, code: "provider_disabled" },
  { method: "POST", path: "/gemini/v1beta/models/claude%2Fclaude-haiku-4-5-20251001:generateContent", body: contents, status: 400, code: "unsupported_feature" },
  { method: "POST", path: "/gemini/v1beta/models/openai%2Fgpt-5.5:streamGenerateContent?alt=sse", body: contents, status: 503, code: "provider_disabled" },
  { method: "POST", path: "/gemini/v1beta/models/antigravity%2Fgemini-3.5-flash-lite:countTokens", body: contents, status: 400, code: "unsupported_feature" },
  { method: "POST", path: "/gemini/v1beta/models/antigravity%2Fgemini-3.5-flash-lite:countTokens", token: false, body: contents, status: 401, code: "unauthorized" },
];

const upstreams = new ReplayUpstreams();
let signedIn: SignedInDaemon | undefined;
beforeAll(async () => {
  upstreams.start();
  const yaml = [
    "providers:",
    "  claude: {enabled: true, acknowledgeTermsRisk: true}",
    "  antigravity: {enabled: true, acknowledgeTermsRisk: true}",
    "  openrouter: {enabled: true}",
    "  opencode: {enabled: true}",
    "  opencode-go: {enabled: true}",
    "  cheaper-inference: {enabled: true}",
    "",
  ].join("\n");
  signedIn = await startSignedInDaemon(upstreams.seamEnv(), yaml);
});
afterAll(async () => {
  if (signedIn !== undefined) {
    await signedIn.daemon.stop();
    removeTemporary(signedIn.home.dir);
  }
  upstreams.stop();
});

describe("reference documentation against the proxy", () => {
  test("the model reference is a fresh generation", async () => {
    expect(await generateModelsReference()).toBe(readFileSync(join(repo, MODELS_REFERENCE), "utf8"));
  });

  test("every OpenAPI operation answers as documented", async () => {
    const { daemon, token } = signedIn!;
    const reached = new Set<string>();
    for (const probe of PROBES) {
      const [path, query] = probe.path.split("?");
      const operation = operationFor(probe.method, path!);
      reached.add(operation.operationId);
      const headers: Record<string, string> = probe.token === false ? {} : { authorization: `Bearer ${token}` };
      if (probe.body !== undefined) headers["content-type"] = "application/json";
      const answer = await fetch(`${daemon.url}${path}${query !== undefined ? `?${query}` : ""}`, { method: probe.method, headers, ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}) });
      const body = (await answer.json()) as unknown;
      const where = `${probe.method} ${probe.path}`;
      expect([where, answer.status]).toEqual([where, probe.status]);
      const documented = responseFor(operation, answer.status);
      const schema = documented.content?.["application/json"]?.schema;
      expect([where, schema !== undefined]).toEqual([where, true]);
      expect([where, validate(spec as unknown as Schema, body, schema)]).toEqual([where, []]);
      for (const header of Object.keys(documented.headers ?? {}).filter((h) => h.startsWith("x-proxy-models"))) expect([where, answer.headers.get(header)]).toEqual([where, expect.stringMatching(/^[a-z-]+=(live|cache|static|unavailable)(,[a-z-]+=(live|cache|static|unavailable))*$/)]);
      // The plain and OpenAI shapes carry the proxy's code; the Anthropic and Google shapes carry the status's name,
      // which their schemas above check.
      const code = (body as { error?: { code?: unknown } }).error?.code;
      if (probe.code !== undefined && typeof code === "string") expect([where, code]).toEqual([where, probe.code]);
      if (probe.code !== undefined) expect([where, answer.headers.get("content-type")]).toEqual([where, "application/json"]);
    }
    const documented = Object.values(spec.paths).flatMap((item) => Object.values(item).map((o) => o.operationId));
    expect([...reached].sort()).toEqual([...documented].sort());
  });

  test("a path outside every route answers the plain error the document describes", async () => {
    const answer = await fetch(`${signedIn!.daemon.url}/nope`);
    const schema = spec.components.responses["PlainError"]!.content!["application/json"]!.schema;
    expect([answer.status, validate(spec as unknown as Schema, await answer.json(), schema)]).toEqual([404, []]);
  });
});
