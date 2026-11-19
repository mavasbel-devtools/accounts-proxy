// The pi configuration over HTTP and the command line, in process (plan 2026-11-15-23-52 stage 4): the real
// RouteHandler, PiConfigCodec and PiConfigCommand with fakes for the ports around them. The Models fake below is
// defined in this file: no catalog fake exists in apps/proxy/tests/component (plan step 4.5 problems row).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeCatalog, type DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ModelCatalog, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { readAll, type HttpResponse, type RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import { DescribeModelsPort, HealthPort, PassthroughPort, RefreshModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { OpencodeConfigCodec } from "@accounts-proxy/dialect-opencode/adapters/inbound/opencode-config-codec.ts";
import { PiConfigCodec } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-config-codec.ts";
import { AnthropicCodec } from "@accounts-proxy/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@accounts-proxy/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@accounts-proxy/dialect-openai/adapters/inbound/openai-codec.ts";
import { MemoryLogger } from "@accounts-proxy/test-support/fakes.ts";
import { validate } from "@accounts-proxy/test-support/json-schema.ts";
import { PiConfigCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/catalog-commands.ts";
import { UsageError } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import type { InboundRequest } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import { RouteHandler } from "@accounts-proxy/proxy/adapters/inbound/http/route-handler.ts";
import { LoggingErrorReporter } from "@accounts-proxy/proxy/application/error-reporter.ts";

// pi 1.5.2's published configuration schema (docs/reference/specs/pi-models-schema.json).
const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "reference", "specs", "pi-models-schema.json"), "utf8")) as Record<string, unknown>;

/** The catalog fake: two providers with models in their native formats (fakes extend the ports). */
class Models extends DescribeModelsPort {
  async describeModels(): Promise<readonly DetailedCatalog[]> {
    const catalogs: ModelCatalog[] = [
      {
        provider: "claude",
        formats: ["anthropic-messages"],
        source: "live",
        models: [{ address: { provider: "claude", model: "c" }, displayName: "C", contextWindow: 200000, maxOutputTokens: 32000 }],
      },
      {
        provider: "antigravity",
        formats: ["gemini"],
        source: "live",
        models: [{ address: { provider: "antigravity", model: "g" }, displayName: "G" }],
      },
    ];
    return catalogs.map((c) => describeCatalog(c, undefined, undefined));
  }
}

class Access extends AccessPort {
  async token() {
    return "T";
  }
  async authorize(candidate: string | undefined) {
    return candidate === "T";
  }
}

class Passthrough extends PassthroughPort {
  forward(_format: WireFormat, _model: string, _request: RawRequest): Promise<HttpResponse> {
    throw new Error("no passthrough in the pi-config component suite");
  }
}

class Health extends HealthPort {
  enabledProviders() {
    return ["claude", "antigravity"] as const;
  }
}

class Refresh extends RefreshModelsPort {
  async refreshModels(): Promise<readonly DetailedCatalog[]> {
    return [];
  }
}

const ORIGIN = { origin: "http://127.0.0.1:4141", tokenCommand: ["proxy", "token"] };

const setup = () => {
  const models = new Models();
  const pi = new PiConfigCodec();
  const handler = new RouteHandler(
    [new AnthropicCodec(), new OpenAiCodec(), new GeminiCodec()],
    { access: new Access(), passthrough: new Passthrough(), health: new Health(), describe: models, refresh: new Refresh(), opencode: new OpencodeConfigCodec(), pi, origin: ORIGIN },
    new LoggingErrorReporter(new MemoryLogger()),
  );
  const command = new PiConfigCommand(models, pi, ORIGIN);
  return { handler, command };
};

const request = (method: string, path: string, token = true): InboundRequest => ({
  method,
  path,
  query: {},
  headers: token ? { authorization: "Bearer T" } : {},
  rawHeaders: [],
  readBody: async () => "{}",
  signal: new AbortController().signal,
});

const runCommand = async (args: readonly string[]): Promise<unknown> => {
  const { command } = setup();
  const out: string[] = [];
  await command.run(args, (t) => out.push(t));
  return JSON.parse(out.join("")) as unknown;
};

describe("pi configuration over HTTP and the command line", () => {
  test("pi-config prints a schema-valid document of the enabled providers [feature=pi-config use-case=uc-pi-1 tier=component polarity=positive]", async () => {
    const doc = (await runCommand([])) as { providers: Record<string, unknown> };
    expect(validate(schema, doc)).toEqual([]);
    expect(Object.keys(doc.providers).sort()).toEqual(["ap-antigravity", "ap-claude"]);
  });

  test("pi-config with an argument fails without printing [feature=pi-config use-case=uc-pi-1 tier=component polarity=negative]", async () => {
    const { command } = setup();
    const out: string[] = [];
    const error = await command.run(["x"], (t) => out.push(t)).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe("pi-config takes no arguments");
    expect(out).toEqual([]);
  });

  test("GET /pi/models.json serves the command's document [feature=pi-config use-case=uc-pi-2 tier=component polarity=positive]", async () => {
    const { handler } = setup();
    const response = await handler.handle(request("GET", "/pi/models.json"));
    expect(response.status).toBe(200);
    const body = JSON.parse(await readAll(response.body)) as unknown;
    expect(body).toEqual(await runCommand([]));
    expect(validate(schema, body as Record<string, unknown>)).toEqual([]);
  });

  test("GET /pi/models.json without the token is a plain JSON 401 [feature=pi-config use-case=uc-pi-2 tier=component polarity=negative]", async () => {
    const { handler } = setup();
    const response = await handler.handle(request("GET", "/pi/models.json", false));
    expect(response.status).toBe(401);
    expect(JSON.parse(await readAll(response.body)) as unknown).toEqual({ error: { code: "unauthorized", message: "missing or invalid accounts-proxy token" } });
  });

  test("GET /.well-known/pi is the open manifest [feature=pi-config use-case=uc-pi-3 tier=component polarity=positive]", async () => {
    const { handler } = setup();
    const response = await handler.handle(request("GET", "/.well-known/pi", false));
    expect(response.status).toBe(200);
    expect(JSON.parse(await readAll(response.body)) as unknown).toEqual({
      auth: { command: ["proxy", "token"], env: "ACCOUNTS_PROXY_TOKEN" },
      config: { url: "http://127.0.0.1:4141/pi/models.json" },
    });
  });

  test("POST /.well-known/pi is a 404 [feature=pi-config use-case=uc-pi-3 tier=component polarity=negative]", async () => {
    const { handler } = setup();
    const response = await handler.handle(request("POST", "/.well-known/pi", false));
    expect(response.status).toBe(404);
    expect(JSON.parse(await readAll(response.body)) as unknown).toEqual({ error: { code: "not_found", message: "no route POST /.well-known/pi" } });
  });
});
