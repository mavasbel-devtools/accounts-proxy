// Composition root: the ONLY place concrete adapters are constructed (AGENTS.md §2). Providers and their login
// clients are wired only when enabled with acknowledgeTermsRisk (plan D4). Upstream seams (P4 plan §2.5) exist only
// for hermetic e2e: INFERENCE_ROUTER_TEST_UPSTREAM_* repoint a provider's hosts, and only to http://127.0.0.1 — any
// other value is a fatal configuration error, so a production configuration can never be redirected.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { enabledProviders, parseRouterConfig, type RouterConfig } from "@inference-router/core/domain/config.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import type { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import type { OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import type { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { BrowserLauncherPort, ClockPort, LoggerPort, RandomPort, TimerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import type { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";
import { AnthropicCodec } from "@inference-router/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@inference-router/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@inference-router/dialect-openai/adapters/inbound/openai-codec.ts";
import { AntigravityApiClient } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-api-client.ts";
import { AntigravityCatalog } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-catalog.ts";
import { AntigravityNative } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-native.ts";
import { AntigravityProvider } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-provider.ts";
import { AntigravityQuota } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-quota.ts";
import { AntigravityRunner } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-runner.ts";
import { AntigravitySession } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-session.ts";
import { AntigravityState } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-state.ts";
import { GoogleOAuthClient, PRODUCTION_ENDPOINTS as GOOGLE_ENDPOINTS } from "@inference-router/provider-antigravity/adapters/outbound/google-oauth-client.ts";
import { DAILY_HOST, USERINFO_URL } from "@inference-router/provider-antigravity/domain/constants.ts";
import type {
  AntigravityApiPort,
  AntigravityCatalogPort,
  AntigravityOAuthPort,
  AntigravityQuotaPort,
  AntigravitySessionPort,
  AntigravityStatePort,
} from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";
import { ClaudeCatalog } from "@inference-router/provider-claude/adapters/outbound/claude-catalog.ts";
import { ClaudeIdentity } from "@inference-router/provider-claude/adapters/outbound/claude-identity.ts";
import { ClaudeOAuthClient, PRODUCTION_ENDPOINTS as CLAUDE_ENDPOINTS } from "@inference-router/provider-claude/adapters/outbound/claude-oauth-client.ts";
import { ClaudeSession } from "@inference-router/provider-claude/adapters/outbound/claude-session.ts";
import { ClaudeSubscriptionProvider } from "@inference-router/provider-claude/adapters/outbound/claude-subscription-provider.ts";
import { API_BASE as CLAUDE_API_BASE } from "@inference-router/provider-claude/domain/constants.ts";
import type { ClaudeCatalogPort, ClaudeIdentityPort, ClaudeOAuthPort, ClaudeSessionPort } from "@inference-router/provider-claude/ports/outbound/claude.ts";
import { CliDriver, type Writer } from "@inference-router/router/adapters/inbound/cli/cli-driver.ts";
import type { Driver } from "@inference-router/router/adapters/inbound/driver.ts";
import { MAX_BODY_BYTES, NodeHttpServer } from "@inference-router/router/adapters/inbound/http/node-http-server.ts";
import { RouteHandler } from "@inference-router/router/adapters/inbound/http/route-handler.ts";
import { ProcessShutdownSignal } from "@inference-router/router/adapters/inbound/process-shutdown-signal.ts";
import type { ShutdownSignal } from "@inference-router/router/adapters/inbound/server.ts";
import { SystemBrowserLauncher } from "@inference-router/router/adapters/outbound/browser-launcher.ts";
import { FetchTransport } from "@inference-router/router/adapters/outbound/fetch-transport.ts";
import { FileLock } from "@inference-router/router/adapters/outbound/file-lock.ts";
import { FileCredentialStore, FileKeyValueStore, FileRouterTokenStore } from "@inference-router/router/adapters/outbound/file-stores.ts";
import { LoopbackCallbackServerFactory } from "@inference-router/router/adapters/outbound/loopback-callback-server.ts";
import { CryptoRandom, FileLogger, NodeHash, SystemClock, SystemTimer } from "@inference-router/router/adapters/outbound/system.ts";
import { TerminalManualCode } from "@inference-router/router/adapters/outbound/terminal-manual-code.ts";
import { YamlConfigFile } from "@inference-router/router/adapters/outbound/yaml-config-file.ts";
import { AccessService } from "@inference-router/router/application/access-service.ts";
import { AccountAdminService, UsageService } from "@inference-router/router/application/account-services.ts";
import { DaemonStatusService } from "@inference-router/router/application/daemon-status-service.ts";
import { LoggingErrorReporter } from "@inference-router/router/application/error-reporter.ts";
import { ListModelsService } from "@inference-router/router/application/list-models-service.ts";
import { LoginService } from "@inference-router/router/application/login-service.ts";
import { HealthService, PassthroughService } from "@inference-router/router/application/passthrough-service.ts";

/** The daemon binds this host only (AGENTS.md §4 Local access). */
export const LOOPBACK_HOST = "127.0.0.1";

/** Hermetic-only replacement origins for the providers' upstream hosts (e2e replay servers). */
export type UpstreamSeams = {
  readonly claudeApi?: string;
  readonly claudeOAuth?: string;
  readonly antigravityApi?: string;
  readonly googleOAuth?: string;
};

const SEAM_VARIABLES: Readonly<Record<keyof UpstreamSeams, string>> = {
  claudeApi: "INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_API",
  claudeOAuth: "INFERENCE_ROUTER_TEST_UPSTREAM_CLAUDE_OAUTH",
  antigravityApi: "INFERENCE_ROUTER_TEST_UPSTREAM_ANTIGRAVITY_API",
  googleOAuth: "INFERENCE_ROUTER_TEST_UPSTREAM_GOOGLE_OAUTH",
};

export class UpstreamSeamError extends Error {
  constructor(name: string, value: string) {
    super(`${name} must be an http://${LOOPBACK_HOST}:<port> origin (hermetic tests only), got ${JSON.stringify(value)}`);
    this.name = "UpstreamSeamError";
  }
}

/** Reads the seam variables; each value must be an http://127.0.0.1:<port> origin, else UpstreamSeamError. */
export function seamsFrom(env: Readonly<Record<string, string | undefined>>): UpstreamSeams {
  const seams: Record<string, string> = {};
  for (const [key, name] of Object.entries(SEAM_VARIABLES)) {
    const value = env[name];
    if (value === undefined) continue;
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (url === undefined || url.protocol !== "http:" || url.hostname !== LOOPBACK_HOST || url.pathname !== "/" || url.search !== "") {
      throw new UpstreamSeamError(name, value);
    }
    seams[key] = url.origin;
  }
  return seams;
}

/** The production URL with its origin replaced by the seam origin (path and query kept). */
function onOrigin(production: string, origin: string | undefined): string {
  if (origin === undefined) return production;
  const url = new URL(production);
  return `${origin}${url.pathname}${url.search}`;
}

export type ContainerOptions = {
  /** Data directory: router.yaml, token.json, accounts-*.json, state/, locks/, logs/. */
  readonly home: string;
  readonly out: Writer;
  readonly err: Writer;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Seams for hermetic tests; production uses the real network, browser and process signals. */
  readonly transport?: HttpTransportPort;
  readonly browser?: BrowserLauncherPort;
  readonly shutdown?: ShutdownSignal;
  readonly seams?: UpstreamSeams;
};

export function defaultHome(env: Readonly<Record<string, string | undefined>>): string {
  return env["INFERENCE_ROUTER_HOME"] ?? join(homedir(), ".local", "share", "inference-router");
}

export type GraphOptions = {
  readonly home: string;
  readonly transport?: HttpTransportPort;
  readonly seams?: UpstreamSeams;
};

/** The wired provider objects, typed by their abstractions (used by the CLI and by scripts/evidence/live). */
export type ClaudeGraph = {
  readonly oauth: ClaudeOAuthPort;
  readonly session: ClaudeSessionPort;
  readonly identity: ClaudeIdentityPort;
  readonly catalog: ClaudeCatalogPort;
  readonly provider: ProviderPort;
};
export type AntigravityGraph = {
  readonly oauth: AntigravityOAuthPort;
  readonly api: AntigravityApiPort;
  readonly session: AntigravitySessionPort;
  readonly state: AntigravityStatePort;
  readonly catalog: AntigravityCatalogPort;
  readonly quota: AntigravityQuotaPort;
  readonly provider: ProviderPort;
};
export type ProviderGraph = {
  readonly config: RouterConfig;
  readonly enabled: readonly ProviderId[];
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly timer: TimerPort;
  readonly logger: LoggerPort;
  readonly store: CredentialStorePort;
  readonly transport: HttpTransportPort;
  readonly claude?: ClaudeGraph;
  readonly antigravity?: AntigravityGraph;
};

export async function buildGraph(options: GraphOptions): Promise<ProviderGraph> {
  const config = parseRouterConfig(await new YamlConfigFile(join(options.home, "router.yaml")).read());
  const enabled = enabledProviders(config);
  const seams = options.seams ?? {};
  const clock = new SystemClock();
  const random = new CryptoRandom();
  const timer = new SystemTimer();
  const logger = new FileLogger(join(options.home, "logs", "router.log"), clock);
  const transport = options.transport ?? new FetchTransport();
  const store = new FileCredentialStore(options.home);
  const state = new FileKeyValueStore(options.home);
  const lock = new FileLock(options.home, clock, timer);

  let claude: ClaudeGraph | undefined;
  if (enabled.includes("claude")) {
    const apiBase = seams.claudeApi ?? CLAUDE_API_BASE;
    const oauth = new ClaudeOAuthClient(transport, clock, {
      authorizeUrl: onOrigin(CLAUDE_ENDPOINTS.authorizeUrl, seams.claudeOAuth),
      tokenUrl: onOrigin(CLAUDE_ENDPOINTS.tokenUrl, seams.claudeOAuth),
    });
    const session = new ClaudeSession(store, oauth, lock, clock, logger);
    const catalog = new ClaudeCatalog(transport, session, state, clock, logger, apiBase);
    const identity = new ClaudeIdentity(state, random);
    claude = { oauth, session, identity, catalog, provider: new ClaudeSubscriptionProvider(session, catalog, identity, transport, random, logger, apiBase) };
  }
  let antigravity: AntigravityGraph | undefined;
  if (enabled.includes("antigravity")) {
    const api = new AntigravityApiClient(transport, logger, seams.antigravityApi ?? DAILY_HOST, onOrigin(USERINFO_URL, seams.googleOAuth));
    const oauth = new GoogleOAuthClient(transport, api, clock, random, logger, {
      authorizeUrl: onOrigin(GOOGLE_ENDPOINTS.authorizeUrl, seams.googleOAuth),
      tokenUrl: onOrigin(GOOGLE_ENDPOINTS.tokenUrl, seams.googleOAuth),
    });
    const session = new AntigravitySession(store, oauth, lock, clock, logger);
    const catalog = new AntigravityCatalog(api, session, logger);
    const antigravityState = new AntigravityState(state, random);
    const runner = new AntigravityRunner(api, session, antigravityState, random, clock, timer, logger);
    antigravity = {
      oauth,
      api,
      session,
      state: antigravityState,
      catalog,
      quota: new AntigravityQuota(api, session, clock),
      provider: new AntigravityProvider(catalog, new AntigravityNative(runner, antigravityState, logger), logger),
    };
  }
  return { config, enabled, clock, random, timer, logger, store, transport, ...(claude ? { claude } : {}), ...(antigravity ? { antigravity } : {}) };
}

export async function buildCli(options: ContainerOptions): Promise<{ readonly config: RouterConfig; readonly driver: Driver }> {
  const graph = await buildGraph(options);
  const clients: OAuthClientPort[] = [];
  const providers: ProviderPort[] = [];
  const reporters: UsageReporterPort[] = [];
  for (const wired of [graph.claude, graph.antigravity]) {
    if (wired === undefined) continue;
    clients.push(wired.oauth);
    providers.push(wired.provider);
  }
  if (graph.antigravity) reporters.push(graph.antigravity.quota);

  const hash = new NodeHash();
  const login = new LoginService(
    clients,
    new LoopbackCallbackServerFactory(),
    options.browser ?? new SystemBrowserLauncher(),
    new TerminalManualCode(options.stdin, options.stdout),
    graph.store,
    graph.random,
    hash,
    graph.logger,
  );
  const access = new AccessService(new FileRouterTokenStore(options.home), graph.random, hash);
  const models = new ListModelsService(providers);
  const health = new HealthService(graph.enabled);
  const errors = new LoggingErrorReporter(graph.logger);
  const handler = new RouteHandler(
    [new AnthropicCodec(), new OpenAiCodec(), new GeminiCodec()],
    { access, passthrough: new PassthroughService(providers, graph.config.aliases), models, health },
    errors,
  );
  const server = new NodeHttpServer(handler, { host: LOOPBACK_HOST, port: graph.config.port, maxBodyBytes: MAX_BODY_BYTES }, errors);
  const driver = new CliDriver(
    {
      login,
      accounts: new AccountAdminService(graph.store),
      usage: new UsageService(graph.enabled, reporters),
      models,
      access,
      health,
      status: new DaemonStatusService(graph.transport, `http://${LOOPBACK_HOST}:${graph.config.port}`),
    },
    { server, shutdown: options.shutdown ?? new ProcessShutdownSignal() },
    options.out,
    options.err,
  );
  return { config: graph.config, driver };
}

/** Builds and runs the CLI; configuration and store errors are reported, never thrown. */
export async function runCli(argv: readonly string[], options: ContainerOptions): Promise<number> {
  let driver: Driver;
  try {
    driver = (await buildCli(options)).driver;
  } catch (error) {
    options.err(`error: ${errorMessage(error)}\n`);
    return 1;
  }
  return driver.run(argv);
}

/** Production entry: real home, terminal, network and process signals (seams only from the hermetic variables). */
export async function main(argv: readonly string[]): Promise<number> {
  const err = (text: string) => void process.stderr.write(text);
  let seams: UpstreamSeams;
  try {
    seams = seamsFrom(process.env);
  } catch (error) {
    err(`error: ${(error as Error).message}\n`);
    return 1;
  }
  return runCli(argv, {
    home: defaultHome(process.env),
    out: (text) => process.stdout.write(text),
    err,
    stdin: process.stdin,
    stdout: process.stdout,
    seams,
  });
}
