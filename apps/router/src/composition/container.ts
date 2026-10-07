// Composition root: the ONLY place concrete adapters are constructed (AGENTS.md §2). Providers and their login
// clients are wired only when enabled with acknowledgeTermsRisk (plan D4).
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { enabledProviders, parseRouterConfig, type RouterConfig } from "@inference-router/core/domain/config.ts";
import type { OAuthClientPort } from "@inference-router/core/ports/outbound/oauth.ts";
import type { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import type { BrowserLauncherPort } from "@inference-router/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";
import type { UsageReporterPort } from "@inference-router/core/ports/outbound/usage.ts";
import { AntigravityApiClient } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-api-client.ts";
import { AntigravityCatalog } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-catalog.ts";
import { AntigravityProvider } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-provider.ts";
import { AntigravityQuota } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-quota.ts";
import { AntigravitySession } from "@inference-router/provider-antigravity/adapters/outbound/antigravity-session.ts";
import { GoogleOAuthClient } from "@inference-router/provider-antigravity/adapters/outbound/google-oauth-client.ts";
import { ClaudeCatalog } from "@inference-router/provider-claude/adapters/outbound/claude-catalog.ts";
import { ClaudeIdentity } from "@inference-router/provider-claude/adapters/outbound/claude-identity.ts";
import { ClaudeOAuthClient } from "@inference-router/provider-claude/adapters/outbound/claude-oauth-client.ts";
import { ClaudeSession } from "@inference-router/provider-claude/adapters/outbound/claude-session.ts";
import { ClaudeSubscriptionProvider } from "@inference-router/provider-claude/adapters/outbound/claude-subscription-provider.ts";
import { CliDriver, type Writer } from "@inference-router/router/adapters/inbound/cli/cli-driver.ts";
import type { Driver } from "@inference-router/router/adapters/inbound/driver.ts";
import { SystemBrowserLauncher } from "@inference-router/router/adapters/outbound/browser-launcher.ts";
import { FetchTransport } from "@inference-router/router/adapters/outbound/fetch-transport.ts";
import { FileLock } from "@inference-router/router/adapters/outbound/file-lock.ts";
import { FileCredentialStore, FileKeyValueStore } from "@inference-router/router/adapters/outbound/file-stores.ts";
import { LoopbackCallbackServerFactory } from "@inference-router/router/adapters/outbound/loopback-callback-server.ts";
import { CryptoRandom, FileLogger, NodeHash, SystemClock, SystemTimer } from "@inference-router/router/adapters/outbound/system.ts";
import { TerminalManualCode } from "@inference-router/router/adapters/outbound/terminal-manual-code.ts";
import { YamlConfigFile } from "@inference-router/router/adapters/outbound/yaml-config-file.ts";
import { AccountAdminService, UsageService } from "@inference-router/router/application/account-services.ts";
import { ListModelsService } from "@inference-router/router/application/list-models-service.ts";
import { LoginService } from "@inference-router/router/application/login-service.ts";

export type ContainerOptions = {
  /** Data directory: router.yaml, accounts-*.json, state/, locks/, logs/. */
  readonly home: string;
  readonly out: Writer;
  readonly err: Writer;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Seams for hermetic tests; production uses the real network and browser. */
  readonly transport?: HttpTransportPort;
  readonly browser?: BrowserLauncherPort;
};

export function defaultHome(env: Readonly<Record<string, string | undefined>>): string {
  return env["INFERENCE_ROUTER_HOME"] ?? join(homedir(), ".local", "share", "inference-router");
}

export async function buildCli(options: ContainerOptions): Promise<{ readonly config: RouterConfig; readonly driver: Driver }> {
  const config = parseRouterConfig(await new YamlConfigFile(join(options.home, "router.yaml")).read());
  const enabled = enabledProviders(config);
  const clock = new SystemClock();
  const random = new CryptoRandom();
  const timer = new SystemTimer();
  const logger = new FileLogger(join(options.home, "logs", "router.log"), clock);
  const transport = options.transport ?? new FetchTransport();
  const store = new FileCredentialStore(options.home);
  const state = new FileKeyValueStore(options.home);
  const lock = new FileLock(options.home, clock, timer);

  const clients: OAuthClientPort[] = [];
  const providers: ProviderPort[] = [];
  const reporters: UsageReporterPort[] = [];
  if (enabled.includes("claude-subscription")) {
    const oauth = new ClaudeOAuthClient(transport, clock);
    const session = new ClaudeSession(store, oauth, lock, clock, logger);
    const catalog = new ClaudeCatalog(transport, session, state, clock, logger);
    clients.push(oauth);
    providers.push(new ClaudeSubscriptionProvider(session, catalog, new ClaudeIdentity(state, random), transport, random, logger));
  }
  if (enabled.includes("antigravity")) {
    const api = new AntigravityApiClient(transport, logger);
    const oauth = new GoogleOAuthClient(transport, api, clock, random, logger);
    const session = new AntigravitySession(store, oauth, lock, clock, logger);
    clients.push(oauth);
    providers.push(new AntigravityProvider(new AntigravityCatalog(api, session, logger)));
    reporters.push(new AntigravityQuota(api, session, clock));
  }

  const login = new LoginService(
    clients,
    new LoopbackCallbackServerFactory(),
    options.browser ?? new SystemBrowserLauncher(),
    new TerminalManualCode(options.stdin, options.stdout),
    store,
    random,
    new NodeHash(),
    logger,
  );
  const driver = new CliDriver(
    { login, accounts: new AccountAdminService(store), usage: new UsageService(enabled, reporters), models: new ListModelsService(providers) },
    options.out,
    options.err,
  );
  return { config, driver };
}

/** Builds and runs the CLI; configuration and store errors are reported, never thrown. */
export async function runCli(argv: readonly string[], options: ContainerOptions): Promise<number> {
  let driver: Driver;
  try {
    driver = (await buildCli(options)).driver;
  } catch (error) {
    options.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return driver.run(argv);
}

/** Production entry: real home, terminal and network. */
export function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, {
    home: defaultHome(process.env),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    stdin: process.stdin,
    stdout: process.stdout,
  });
}
