// Composition root: the ONLY place concrete adapters are constructed (AGENTS.md §2). Providers and their login
// clients are wired only when enabled with acknowledgeTermsRisk (plan D4). Upstream seams (P4 plan §2.5) exist only
// for hermetic e2e: ACCOUNTS_PROXY_TEST_UPSTREAM_* repoint a provider's hosts, and only to http://127.0.0.1 — any
// other value is a fatal configuration error, so a production configuration can never be redirected.
import * as nodeFs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { enabledProviders, modelListMaxAgeMs, parseProxyConfig, type ProxyConfig } from "@accounts-proxy/core/domain/config.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { UPSTREAM_IDLE_TIMEOUT_MS } from "@accounts-proxy/core/domain/wire.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import type { ApiKeyLoginPort } from "@accounts-proxy/core/ports/outbound/api-key.ts";
import type { DeviceLoginClientPort } from "@accounts-proxy/core/ports/outbound/device.ts";
import type { CredentialStorePort } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import type { OAuthClientPort } from "@accounts-proxy/core/ports/outbound/oauth.ts";
import type { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import type { BrowserLauncherPort, ClockPort, ConsoleMirrorPort, HashPort, LockPort, LoggerPort, RandomPort, TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";
import type { UsageReporterPort } from "@accounts-proxy/core/ports/outbound/usage.ts";
import { AnthropicCodec } from "@accounts-proxy/dialect-anthropic/adapters/inbound/anthropic-codec.ts";
import { GeminiCodec } from "@accounts-proxy/dialect-gemini/adapters/inbound/gemini-codec.ts";
import { OpenAiCodec } from "@accounts-proxy/dialect-openai/adapters/inbound/openai-codec.ts";
import { AntigravityApiClient } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-api-client.ts";
import { AntigravityCatalog, AntigravityModelList } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-catalog.ts";
import { AntigravityNative } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-native.ts";
import { AntigravityProvider } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-provider.ts";
import { AntigravityQuota } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-quota.ts";
import { AntigravityRunner } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-runner.ts";
import { AntigravitySession } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-session.ts";
import { AntigravityState } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-state.ts";
import { GoogleOAuthClient, PRODUCTION_ENDPOINTS as GOOGLE_ENDPOINTS } from "@accounts-proxy/provider-antigravity/adapters/outbound/google-oauth-client.ts";
import { DAILY_HOST, USERINFO_URL } from "@accounts-proxy/provider-antigravity/domain/constants.ts";
import type {
  AntigravityApiPort,
  AntigravityCatalogPort,
  AntigravityOAuthPort,
  AntigravityQuotaPort,
  AntigravitySessionPort,
  AntigravityStatePort,
} from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";
import { CheaperCatalogSource, CheaperKeyLogin, CheaperQuota } from "@accounts-proxy/provider-cheaper-inference/adapters/outbound/cheaper-inference-adapters.ts";
import { CHEAPER_BUILTIN } from "@accounts-proxy/provider-cheaper-inference/domain/builtin-models.ts";
import { CHEAPER_SPEC, PUBLIC_MODELS_URL as CHEAPER_PUBLIC_MODELS_URL } from "@accounts-proxy/provider-cheaper-inference/domain/cheaper-inference.ts";
import { ClaudeCatalog, ClaudeModelList } from "@accounts-proxy/provider-claude/adapters/outbound/claude-catalog.ts";
import { ClaudeIdentity } from "@accounts-proxy/provider-claude/adapters/outbound/claude-identity.ts";
import { ClaudeOAuthClient, PRODUCTION_ENDPOINTS as CLAUDE_ENDPOINTS } from "@accounts-proxy/provider-claude/adapters/outbound/claude-oauth-client.ts";
import { ClaudeSession } from "@accounts-proxy/provider-claude/adapters/outbound/claude-session.ts";
import { ClaudeSubscriptionProvider } from "@accounts-proxy/provider-claude/adapters/outbound/claude-subscription-provider.ts";
import { API_BASE as CLAUDE_API_BASE } from "@accounts-proxy/provider-claude/domain/constants.ts";
import type { ClaudeCatalogPort, ClaudeIdentityPort, ClaudeOAuthPort, ClaudeSessionPort } from "@accounts-proxy/provider-claude/ports/outbound/claude.ts";
import { GatewayCatalog, GatewayModelList } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-catalog.ts";
import { GatewayKeySession } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-key-session.ts";
import { GatewayProvider } from "@accounts-proxy/provider-gateway/adapters/outbound/gateway-provider.ts";
import type { GatewayModel, GatewaySpec } from "@accounts-proxy/provider-gateway/domain/gateway.ts";
import type { GatewayCatalogPort, GatewayCatalogSourcePort, GatewayKeySessionPort } from "@accounts-proxy/provider-gateway/ports/outbound/gateway.ts";
import { JwksIdTokenVerifier } from "@accounts-proxy/provider-openai/adapters/outbound/jwks-id-token-verifier.ts";
import { OpenAICatalog } from "@accounts-proxy/provider-openai/adapters/outbound/openai-catalog.ts";
import { OpenAIIdentity } from "@accounts-proxy/provider-openai/adapters/outbound/openai-identity.ts";
import { OpenAIOAuthClient } from "@accounts-proxy/provider-openai/adapters/outbound/openai-oauth-client.ts";
import { OpenAIProvider } from "@accounts-proxy/provider-openai/adapters/outbound/openai-provider.ts";
import { OpenAISession } from "@accounts-proxy/provider-openai/adapters/outbound/openai-session.ts";
import { API_BASE as OPENAI_API_BASE, ISSUER as OPENAI_ISSUER, JWKS_PATH as OPENAI_JWKS_PATH } from "@accounts-proxy/provider-openai/domain/constants.ts";
import type { OpenAICatalogPort, OpenAIIdentityPort, OpenAIOAuthPort, OpenAISessionPort } from "@accounts-proxy/provider-openai/ports/outbound/openai.ts";
import { OpencodeCatalogSource } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-catalog-source.ts";
import { OpencodeConsoleClient } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-console-client.ts";
import { OpencodeDeviceLogin, OpencodeKeyLogin } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-logins.ts";
import { ConsoleGatewaySession, ConsoleSession } from "@accounts-proxy/provider-opencode/adapters/outbound/opencode-session.ts";
import { GO_BUILTIN, ZEN_BUILTIN } from "@accounts-proxy/provider-opencode/domain/builtin-models.ts";
import { CONSOLE_URL, GO_SPEC, OPENCODE_PROVIDERS, ZEN_SPEC, type OpencodeProvider } from "@accounts-proxy/provider-opencode/domain/opencode.ts";
import type { ConsoleApiPort, ConsoleSessionPort } from "@accounts-proxy/provider-opencode/ports/outbound/console.ts";
import { OpenRouterCatalogSource } from "@accounts-proxy/provider-openrouter/adapters/outbound/openrouter-catalog-source.ts";
import { OpenRouterOAuthClient } from "@accounts-proxy/provider-openrouter/adapters/outbound/openrouter-oauth-client.ts";
import { OpenRouterKeyLogin } from "@accounts-proxy/provider-openrouter/adapters/outbound/openrouter-key-login.ts";
import { OpenRouterQuota } from "@accounts-proxy/provider-openrouter/adapters/outbound/openrouter-quota.ts";
import { OPENROUTER_BUILTIN } from "@accounts-proxy/provider-openrouter/domain/builtin-models.ts";
import { AUTH_URL as OPENROUTER_AUTH_URL, OPENROUTER_SPEC } from "@accounts-proxy/provider-openrouter/domain/openrouter.ts";
import { CommandLineDriver } from "@accounts-proxy/proxy/adapters/inbound/cli/command-line-driver.ts";
import { PROGRAM } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import { type CliCommand, CommandRoot, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { AccountCommand, AccountListCommand, AccountRemoveCommand, AccountUseCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/account-command.ts";
import { ModelsCommand, OpencodeConfigCommand, QuotaCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/catalog-commands.ts";
import { type CliDaemon, ServeCommand, StatusCommand, TokenCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/daemon-commands.ts";
import { CostCommand, type CostSeams, type ReconcileOutcome } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/cost-command.ts";
import { SpendReportService } from "@accounts-proxy/proxy/application/spend-report-service.ts";
import { SpendLogReader } from "@accounts-proxy/proxy/adapters/outbound/spend-log-reader.ts";
import { LoginCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/login-command.ts";
import { type CliPorts, HELP_HELP, PROXY_HELP } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/proxy-commands.ts";
import { HelpCommand } from "@accounts-proxy/proxy/adapters/inbound/cli/help-command.ts";
import type { HttpHandler } from "@accounts-proxy/proxy/adapters/inbound/http/http-handler.ts";
import type { ErrorReporterPort } from "@accounts-proxy/core/ports/inbound/diagnostics.ts";
import type { Driver } from "@accounts-proxy/proxy/adapters/inbound/driver.ts";
import { MAX_BODY_BYTES, NodeHttpServer } from "@accounts-proxy/proxy/adapters/inbound/http/node-http-server.ts";
import { RouteHandler } from "@accounts-proxy/proxy/adapters/inbound/http/route-handler.ts";
import { ProcessShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/process-shutdown-signal.ts";
import type { ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";
import { SystemBrowserLauncher } from "@accounts-proxy/proxy/adapters/outbound/browser-launcher.ts";
import { FetchTransport, type FetchFunction } from "@accounts-proxy/proxy/adapters/outbound/fetch-transport.ts";
import { DEFAULT_LOCK_OPTIONS, FileLock, vanishingStatFs, type FileLockOptions, type LockFs } from "@accounts-proxy/proxy/adapters/outbound/file-lock.ts";
import { AccountsFileStore, editedAccountsFs, FileKeyValueStore, FileProxyTokenStore, type AccountsFileFs } from "@accounts-proxy/proxy/adapters/outbound/file-stores.ts";
import { LoopbackCallbackServerFactory } from "@accounts-proxy/proxy/adapters/outbound/loopback-callback-server.ts";
import { CryptoRandom, NodeHash, StreamLogger, SystemClock, SystemTimer } from "@accounts-proxy/proxy/adapters/outbound/system.ts";
import { LockedLogRetention, PROXY_LOG, USAGE_LOG, WinstonLogStream, type LogKind } from "@accounts-proxy/proxy/adapters/outbound/log-files.ts";
import { ZstdContentDecoder, ZstdContentEncoder } from "@accounts-proxy/proxy/adapters/outbound/zstd-content-encoder.ts";
import { AsyncExchangeScope, StreamExchangeSink } from "@accounts-proxy/proxy/adapters/outbound/exchange-log-file.ts";
import { MirroredLogger, TerminalMirror } from "@accounts-proxy/proxy/adapters/outbound/console-mirror.ts";
import { DaemonConsoleService } from "@accounts-proxy/proxy/application/daemon-console-service.ts";
import { LoggingTransport } from "@accounts-proxy/proxy/adapters/outbound/logging-transport.ts";
import { LoggingBrowserLauncher, LoggingCallbackServerFactory } from "@accounts-proxy/proxy/adapters/outbound/logging-login.ts";
import { LoggingHttpHandler } from "@accounts-proxy/proxy/adapters/inbound/http/logging-http-handler.ts";
import { ClientExchangeService } from "@accounts-proxy/proxy/application/client-exchange-service.ts";
import type { ExchangeScopePort, ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import { TerminalManualCode } from "@accounts-proxy/proxy/adapters/outbound/terminal-manual-code.ts";
import { TerminalSecretPrompt } from "@accounts-proxy/proxy/adapters/outbound/terminal-secret-prompt.ts";
import { YamlConfigFile } from "@accounts-proxy/proxy/adapters/outbound/yaml-config-file.ts";
import { AccessService } from "@accounts-proxy/proxy/application/access-service.ts";
import { AccountAdminService, UsageService } from "@accounts-proxy/proxy/application/account-services.ts";
import { DaemonStatusService } from "@accounts-proxy/proxy/application/daemon-status-service.ts";
import { LoggingErrorReporter } from "@accounts-proxy/proxy/application/error-reporter.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";
import type { RefreshModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ModelReferencePort } from "@accounts-proxy/core/ports/outbound/model-reference.ts";
import { OpencodeConfigCodec } from "@accounts-proxy/dialect-opencode/adapters/inbound/opencode-config-codec.ts";
import { BUILTIN_REFERENCE } from "@accounts-proxy/proxy/adapters/outbound/builtin-model-reference.ts";
import { MODEL_REFERENCE_URL, ModelReferenceCatalog, ModelReferenceList } from "@accounts-proxy/proxy/adapters/outbound/model-reference-catalog.ts";
import type { ModelListCachePort } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";
import { WarmModelsService } from "@accounts-proxy/proxy/application/warm-models-service.ts";
import { DescribeModelsService } from "@accounts-proxy/proxy/application/describe-models-service.ts";
import { ListModelsService } from "@accounts-proxy/proxy/application/list-models-service.ts";
import { RefreshModelsService } from "@accounts-proxy/proxy/application/refresh-models-service.ts";
import { RequestModelRefreshService } from "@accounts-proxy/proxy/application/request-model-refresh-service.ts";
import { LoginService } from "@accounts-proxy/proxy/application/login-service.ts";
import { HealthService, PassthroughService } from "@accounts-proxy/proxy/application/passthrough-service.ts";

/** The daemon binds this host only (AGENTS.md §4 Local access). */
export const LOOPBACK_HOST = "127.0.0.1";

/** Hermetic-only replacement origins for the providers' upstream hosts (e2e replay servers). */
export type UpstreamSeams = {
  readonly claudeApi?: string;
  readonly claudeOAuth?: string;
  readonly antigravityApi?: string;
  readonly googleOAuth?: string;
  readonly openaiApi?: string;
  readonly openaiAuth?: string;
  /**
   * Every API-key gateway host (OpenRouter, opencode.ai, Cheaper Inference) and the reference model catalog
   * (models.opencode.ai) on one origin, paths kept.
   */
  readonly gateways?: string;
};

const SEAM_VARIABLES: Readonly<Record<keyof UpstreamSeams, string>> = {
  claudeApi: "ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_API",
  claudeOAuth: "ACCOUNTS_PROXY_TEST_UPSTREAM_CLAUDE_OAUTH",
  antigravityApi: "ACCOUNTS_PROXY_TEST_UPSTREAM_ANTIGRAVITY_API",
  googleOAuth: "ACCOUNTS_PROXY_TEST_UPSTREAM_GOOGLE_OAUTH",
  openaiApi: "ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_API",
  openaiAuth: "ACCOUNTS_PROXY_TEST_UPSTREAM_OPENAI_AUTH",
  gateways: "ACCOUNTS_PROXY_TEST_UPSTREAM_GATEWAYS",
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

/** Hermetic-test hooks for what a black-box test cannot otherwise reach (R1 option B, group 3). */
export type TestHooks = {
  /** The browser opener's platform (win32 / darwin openers, exercised on Linux). */
  readonly platform: NodeJS.Platform | undefined;
  /** The upstream socket idle timeout (504 paths) instead of UPSTREAM_IDLE_TIMEOUT_MS. */
  readonly upstreamIdleMs: number | undefined;
  /** The cross-process lock timeout instead of DEFAULT_LOCK_OPTIONS.timeoutMs. */
  readonly lockTimeoutMs: number | undefined;
  /** Every stat of a busy lock reports the file gone (the release race). */
  readonly lockStatVanishes: boolean;
  /** The daemon binds UNASSIGNED_TEST_HOST, so listen fails with an error other than EADDRINUSE. */
  readonly listenUnassigned: boolean;
  /** The first n writes of the accounts file see a hand edit before their rename (plan 2026-10-26-23-32 A3b). */
  readonly accountsEdited: number | undefined;
};

/** RFC 5737 TEST-NET-1: documentation-only, never assigned to a host, so binding it always fails (EADDRNOTAVAIL). */
export const UNASSIGNED_TEST_HOST = "192.0.2.1";

const HOOK_VARIABLES = {
  platform: "ACCOUNTS_PROXY_TEST_PLATFORM",
  upstreamIdleMs: "ACCOUNTS_PROXY_TEST_UPSTREAM_IDLE_MS",
  lockTimeoutMs: "ACCOUNTS_PROXY_TEST_LOCK_TIMEOUT_MS",
  lockStatVanishes: "ACCOUNTS_PROXY_TEST_LOCK_STAT_VANISHES",
  listenUnassigned: "ACCOUNTS_PROXY_TEST_LISTEN_UNASSIGNED",
  accountsEdited: "ACCOUNTS_PROXY_TEST_ACCOUNTS_EDITED",
} as const;
const PLATFORMS: readonly string[] = ["linux", "darwin", "win32"];

export class TestHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestHookError";
  }
}

/** Reads the hook variables; any hook requires every upstream seam (so a process that can reach a real
 * provider never runs with one), and every value is validated. */
export function hooksFrom(env: Readonly<Record<string, string | undefined>>, seams: UpstreamSeams): TestHooks {
  const given = Object.values(HOOK_VARIABLES).filter((name) => env[name] !== undefined);
  if (given.length > 0 && Object.keys(seams).length !== Object.keys(SEAM_VARIABLES).length) {
    throw new TestHookError(`${given.join(", ")} need every ACCOUNTS_PROXY_TEST_UPSTREAM_* seam (hermetic tests only)`);
  }
  const platform = env[HOOK_VARIABLES.platform];
  if (platform !== undefined && !PLATFORMS.includes(platform)) throw new TestHookError(`${HOOK_VARIABLES.platform} must be one of ${PLATFORMS.join(", ")}`);
  const positive = (name: string, unit: string): number | undefined => {
    const value = env[name];
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new TestHookError(`${name} must be a positive integer (${unit})`);
    return n;
  };
  const flag = (name: string): boolean => {
    const value = env[name];
    if (value !== undefined && value !== "1") throw new TestHookError(`${name} must be 1`);
    return value === "1";
  };
  return {
    platform: platform as NodeJS.Platform | undefined,
    upstreamIdleMs: positive(HOOK_VARIABLES.upstreamIdleMs, "milliseconds"),
    lockTimeoutMs: positive(HOOK_VARIABLES.lockTimeoutMs, "milliseconds"),
    lockStatVanishes: flag(HOOK_VARIABLES.lockStatVanishes),
    listenUnassigned: flag(HOOK_VARIABLES.listenUnassigned),
    accountsEdited: positive(HOOK_VARIABLES.accountsEdited, "writes"),
  };
}

/** The production URL with its origin replaced by the seam origin (path and query kept). */
function onOrigin(production: string, origin: string | undefined): string {
  if (origin === undefined) return production;
  const url = new URL(production);
  return `${origin}${url.pathname}${url.search}`;
}

export type ContainerOptions = {
  /** Data directory: proxy.yaml, token.json, state/, logs/. */
  readonly home: string;
  /** The one accounts file (plan 2026-10-26-23-32); the locks live in its directory's locks/. */
  readonly accounts: AccountsFileConfig;
  readonly out: Writer;
  readonly err: Writer;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** The network, browser, process signals and lock: main() passes the production ones (with the hermetic hooks). */
  readonly transport: HttpTransportPort;
  readonly browser: BrowserLauncherPort;
  readonly shutdown: ShutdownSignal;
  readonly lock: LockConfig;
  readonly seams: UpstreamSeams;
  /** The daemon's bind address: LOOPBACK_HOST (UNASSIGNED_TEST_HOST only through the hermetic hook). */
  readonly listenHost: string;
  /**
   * How this program is started (the runtime and the entry script, behind `env ACCOUNTS_PROXY_HOME=<home>` when the data
   * directory is not the default one; plan 2026-10-29-14-38 S4): the base of the token command (rule O5).
   */
  readonly entry: readonly string[];
};

export type LockConfig = { readonly options: FileLockOptions; readonly fs: LockFs };
export const PRODUCTION_LOCK: LockConfig = { options: DEFAULT_LOCK_OPTIONS, fs: nodeFs };

/**
 * The data directory (plan 2026-10-29-14-38 S1): ACCOUNTS_PROXY_HOME, else `.cache/` of the repository the program runs
 * from — the nearest directory above `script` whose package.json is named `accounts-proxy` (the source entry and the
 * built bundle alike). Nothing outside the repository is read by default.
 */
/** The command that runs this program again (S4): it names the home only when an override is in effect. */
export function tokenEntry(env: Readonly<Record<string, string | undefined>>, home: string, executable: string, script: readonly string[]): string[] {
  return [...(env["ACCOUNTS_PROXY_HOME"] === undefined ? [] : ["env", `ACCOUNTS_PROXY_HOME=${home}`]), executable, ...script];
}

export function defaultHome(env: Readonly<Record<string, string | undefined>>, script: string): string {
  const given = env["ACCOUNTS_PROXY_HOME"];
  if (given !== undefined) return given;
  let dir = dirname(resolve(script));
  while (!isRepositoryRoot(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return join(dir, ".cache");
}

export const ACCOUNTS_FILE_VARIABLE = "ACCOUNTS_PROXY_ACCOUNTS_FILE";

export class AccountsFileVariableError extends Error {
  constructor(value: string) {
    super(`${ACCOUNTS_FILE_VARIABLE} must be an absolute path (got ${JSON.stringify(value)})`);
    this.name = "AccountsFileVariableError";
  }
}

function isRepositoryRoot(dir: string): boolean {
  const manifest = join(dir, "package.json");
  return existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === "accounts-proxy";
}

/**
 * The accounts file (plan 2026-10-26-23-32 A2, plan 2026-10-29-14-38 S1): ACCOUNTS_PROXY_ACCOUNTS_FILE (an absolute
 * path), else `accounts.json` in the data directory.
 */
export function accountsFileOf(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const given = env[ACCOUNTS_FILE_VARIABLE];
  if (given === undefined) return join(home, "accounts.json");
  if (!isAbsolute(given)) throw new AccountsFileVariableError(given);
  return given;
}

/** The accounts file and the filesystem calls it is written with (plan 2026-10-26-23-32 A1–A3b). */
export type AccountsFileConfig = { readonly path: string; readonly fs: AccountsFileFs };

export type GraphOptions = {
  readonly home: string;
  /** The one accounts file; its directory also holds the locks every writer of it takes (A3a). */
  readonly accounts: AccountsFileConfig;
  /** Where `serve` prints its log lines and exchange records once started (plan 2026-10-27 C1). */
  readonly out: Writer;
  readonly transport: HttpTransportPort;
  readonly lock: LockConfig;
  readonly seams: UpstreamSeams;
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
export type OpenAIGraph = {
  readonly oauth: OpenAIOAuthPort;
  readonly session: OpenAISessionPort;
  readonly identity: OpenAIIdentityPort;
  readonly catalog: OpenAICatalogPort;
  readonly provider: ProviderPort;
};
/**
 * A gateway (plan P4.6): logins by key (`keyLogin`, every gateway), browser (`oauth`) or device code (`device`, the OpenCode
 * Console, amendment A); `console`: the OpenCode Console API and the session shared by opencode and opencode-go.
 */
export type GatewayGraph = {
  readonly spec: GatewaySpec;
  readonly session: GatewayKeySessionPort;
  readonly catalog: GatewayCatalogPort;
  readonly provider: ProviderPort;
  readonly keyLogin: ApiKeyLoginPort;
  readonly oauth?: OAuthClientPort;
  readonly device?: DeviceLoginClientPort;
  readonly quota?: UsageReporterPort;
  readonly console?: { readonly api: ConsoleApiPort; readonly session: ConsoleSessionPort };
};
export type ProviderGraph = {
  readonly config: ProxyConfig;
  readonly enabled: readonly ProviderId[];
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly timer: TimerPort;
  readonly logger: LoggerPort;
  readonly store: CredentialStorePort;
  /** The cross-process lock every file write takes (plan 2026-10-27-23-29 W1). */
  readonly lock: LockPort;
  readonly transport: HttpTransportPort;
  readonly claude?: ClaudeGraph;
  readonly antigravity?: AntigravityGraph;
  readonly openai?: OpenAIGraph;
  readonly gateways: readonly GatewayGraph[];
  /** The reference model catalog (plan 2026-10-16 rule M4), shared by the OpenCode catalogs and the detailed list. */
  readonly reference: ModelReferencePort;
  /** Every kept model list (the reference catalog first), fetched once by `serve` at start (plan 2026-10-28-13-40 M2). */
  readonly modelLists: readonly ModelListCachePort<unknown>[];
  /** The usage log (plan 2026-10-26 X1–X6, plan 2026-10-27-23-29 L2), when `logs.usage`; `transport` already records through it. */
  readonly exchangeLog?: ExchangeLog;
  /** The console copy of `logger`, silent until `serve` starts it (plan 2026-10-27 C1, L5). */
  readonly console: ConsoleMirrorPort;
  /** Ends every log stream of this process, so the last line is on disk (plan 2026-10-27-23-29 L6). */
  readonly closeLogs: () => Promise<void>;
};

export type ExchangeLog = { readonly sink: ExchangeSinkPort; readonly scope: ExchangeScopePort };

/** The log folder: `logs/` next to the accounts file and its `locks/` (plan 2026-10-27-23-29 L1). */
export function logsDirectoryOf(accountsFile: string): string {
  return join(dirname(accountsFile), "logs");
}

export async function buildGraph(options: GraphOptions): Promise<ProviderGraph> {
  const config = parseProxyConfig(await new YamlConfigFile(join(options.home, "proxy.yaml")).read());
  const enabled = enabledProviders(config);
  const seams = options.seams;
  const clock = new SystemClock();
  const random = new CryptoRandom();
  const timer = new SystemTimer();
  const mirror = new TerminalMirror(options.out);
  const lock = new FileLock(dirname(options.accounts.path), clock, timer, options.lock.options, options.lock.fs);
  const logsDirectory = logsDirectoryOf(options.accounts.path);
  const retention = new LockedLogRetention(logsDirectory, lock, clock, config.logs.retentionDays, config.logs.maxTotalMegabytes, nodeFs);
  // The last sweep a new file started; the process waits for it before it exits (L3, L6).
  let swept: Promise<void> = Promise.resolve();
  const streamOf = (kind: LogKind) =>
    new WinstonLogStream(logsDirectory, kind, process.pid, config.logs.maxFileMegabytes, () => {
      swept = retention.sweep();
    });
  const proxyLog = streamOf(PROXY_LOG);
  const usageLog = config.logs.usage ? streamOf(USAGE_LOG) : undefined;
  const logger = new MirroredLogger(new StreamLogger(proxyLog, clock), mirror, clock);
  const exchangeLog = usageLog !== undefined ? { sink: new StreamExchangeSink(usageLog, clock, new NodeHash(), process.pid), scope: new AsyncExchangeScope() } : undefined;
  const transport = exchangeLog !== undefined ? new LoggingTransport(options.transport, exchangeLog.sink, exchangeLog.scope, clock, random, new ZstdContentDecoder()) : options.transport;
  const state = new FileKeyValueStore(options.home, lock);
  const store = new AccountsFileStore(options.accounts.path, lock, options.accounts.fs);
  const maxAgeMs = modelListMaxAgeMs(config);
  const referenceList = new ModelReferenceList(transport, state, clock, logger, onOrigin(MODEL_REFERENCE_URL, seams.gateways), BUILTIN_REFERENCE, maxAgeMs);
  const modelLists: ModelListCachePort<unknown>[] = [referenceList];

  let claude: ClaudeGraph | undefined;
  if (enabled.includes("claude")) {
    const apiBase = seams.claudeApi ?? CLAUDE_API_BASE;
    const oauth = new ClaudeOAuthClient(transport, clock, {
      authorizeUrl: onOrigin(CLAUDE_ENDPOINTS.authorizeUrl, seams.claudeOAuth),
      tokenUrl: onOrigin(CLAUDE_ENDPOINTS.tokenUrl, seams.claudeOAuth),
    });
    const session = new ClaudeSession(store, oauth, lock, clock, logger);
    const list = new ClaudeModelList(transport, session, state, clock, logger, apiBase, maxAgeMs);
    modelLists.push(list);
    const catalog = new ClaudeCatalog(list);
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
    const list = new AntigravityModelList(api, session, state, clock, logger, maxAgeMs);
    modelLists.push(list);
    const catalog = new AntigravityCatalog(list, store);
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
  const reference = new ModelReferenceCatalog(referenceList);
  const openai = enabled.includes("openai") ? wireOpenAI({ seams, transport, store, state, random, clock, lock, logger, reference }) : undefined;
  const gateways = buildGateways({ enabled, seams, transport, store, state, clock, lock, logger, hash: new NodeHash(), reference, maxAgeMs, modelLists });
  return {
    config,
    enabled,
    clock,
    random,
    timer,
    logger,
    store,
    lock,
    transport,
    gateways,
    reference,
    modelLists,
    ...(claude ? { claude } : {}),
    ...(antigravity ? { antigravity } : {}),
    ...(openai ? { openai } : {}),
    ...(exchangeLog ? { exchangeLog } : {}),
    console: mirror,
    closeLogs: async () => {
      await Promise.all([proxyLog.close(), usageLog?.close()]);
      await swept;
    },
  };
}

type OpenAIDeps = {
  readonly seams: UpstreamSeams;
  readonly transport: HttpTransportPort;
  readonly store: CredentialStorePort;
  readonly state: FileKeyValueStore;
  readonly random: RandomPort;
  readonly clock: ClockPort;
  readonly lock: FileLock;
  readonly logger: LoggerPort;
  readonly reference: ModelReferencePort;
};

/** The openai provider (plan v4 P4.5) on its production hosts or on the openai seams. */
function wireOpenAI(deps: OpenAIDeps): OpenAIGraph {
  const { seams, transport, store, state, random, clock, lock, logger, reference } = deps;
  const apiBase = seams.openaiApi ?? OPENAI_API_BASE;
  const authOrigin = seams.openaiAuth ?? OPENAI_ISSUER;
  const identity = new OpenAIIdentity(state, random);
  const oauth = new OpenAIOAuthClient(transport, store, identity, new JwksIdTokenVerifier(transport, clock, `${authOrigin}${OPENAI_JWKS_PATH}`), clock, authOrigin);
  const session = new OpenAISession(store, oauth, lock, clock, logger);
  const catalog = new OpenAICatalog(reference);
  return { oauth, session, identity, catalog, provider: new OpenAIProvider(session, catalog, identity, transport, new ZstdContentEncoder(), logger, apiBase) };
}

type GatewayDeps = {
  readonly enabled: readonly ProviderId[];
  readonly seams: UpstreamSeams;
  readonly transport: HttpTransportPort;
  readonly store: CredentialStorePort;
  readonly state: FileKeyValueStore;
  readonly clock: ClockPort;
  readonly lock: FileLock;
  readonly logger: LoggerPort;
  readonly hash: HashPort;
  readonly reference: ModelReferencePort;
  /** How long a fetched model list is reused (proxy.yaml `modelListMaxAgeMinutes`). */
  readonly maxAgeMs: number;
  /** Each gateway's model list is added here. */
  readonly modelLists: ModelListCachePort<unknown>[];
};

/** The enabled API-key gateways (plan P4.6), each on its production hosts or on the gateways seam. */
function buildGateways(deps: GatewayDeps): GatewayGraph[] {
  const { seams, transport, store, state, clock, lock, logger, hash, reference, maxAgeMs, modelLists } = deps;
  const at = (url: string) => onOrigin(url, seams.gateways);
  const wire = (base: GatewaySpec, source: (spec: GatewaySpec) => GatewayCatalogSourcePort, builtin: readonly GatewayModel[], keySession?: GatewayKeySessionPort) => {
    const spec: GatewaySpec = { ...base, apiBase: at(base.apiBase) };
    const session = keySession ?? new GatewayKeySession(spec.provider, store);
    const list = new GatewayModelList(spec.provider, source(spec), session, state, clock, logger, builtin, maxAgeMs);
    modelLists.push(list);
    const catalog = new GatewayCatalog(list);
    return { spec, session, catalog, provider: new GatewayProvider(spec, session, catalog, transport, logger) };
  };
  const out: GatewayGraph[] = [];
  if (deps.enabled.includes("openrouter")) {
    const g = wire(OPENROUTER_SPEC, (spec) => new OpenRouterCatalogSource(transport, spec.apiBase), OPENROUTER_BUILTIN);
    out.push({
      ...g,
      oauth: new OpenRouterOAuthClient(transport, hash, at(OPENROUTER_AUTH_URL), g.spec.apiBase),
      keyLogin: new OpenRouterKeyLogin(hash, transport, g.spec.apiBase),
      quota: new OpenRouterQuota(transport, g.session, clock, g.spec.apiBase),
    });
  }
  // One Console API and one session for opencode and opencode-go (amendment A, K2).
  if (OPENCODE_PROVIDERS.some((p) => deps.enabled.includes(p))) {
    const api = new OpencodeConsoleClient(transport, clock, at(CONSOLE_URL));
    const consoleSession = new ConsoleSession(store, api, lock, clock, logger);
    for (const [base, builtin] of [
      [ZEN_SPEC, ZEN_BUILTIN],
      [GO_SPEC, GO_BUILTIN],
    ] as const) {
      if (!deps.enabled.includes(base.provider)) continue;
      const provider = base.provider as OpencodeProvider;
      const g = wire(base, () => new OpencodeCatalogSource(provider, reference), builtin, new ConsoleGatewaySession(provider, consoleSession, store));
      out.push({ ...g, keyLogin: new OpencodeKeyLogin(provider, hash, api), device: new OpencodeDeviceLogin(provider, api), console: { api, session: consoleSession } });
    }
  }
  if (deps.enabled.includes("cheaper-inference")) {
    const g = wire(CHEAPER_SPEC, (spec) => new CheaperCatalogSource(transport, spec.apiBase, at(CHEAPER_PUBLIC_MODELS_URL)), CHEAPER_BUILTIN);
    out.push({ ...g, keyLogin: new CheaperKeyLogin(hash, transport, g.spec.apiBase), quota: new CheaperQuota(transport, g.session, clock, g.spec.apiBase) });
  }
  return out;
}

/** The daemon's request handling over a provider graph: also used by scripts/evidence/live to serve a graph in-process. */
export type Routes = {
  readonly handler: HttpHandler;
  readonly errors: ErrorReporterPort;
  readonly ports: Pick<CliPorts, "models" | "opencode" | "origin" | "access" | "health">;
  /** The daemon's refresh of the model lists, also run by `models --refresh` when no daemon listens. */
  readonly refresh: RefreshModelsPort;
};

export function buildRoutes(graph: ProviderGraph, home: string, entry: readonly string[]): Routes {
  const providers: ProviderPort[] = [];
  for (const wired of [graph.claude, graph.antigravity, graph.openai]) if (wired !== undefined) providers.push(wired.provider);
  for (const gateway of graph.gateways) providers.push(gateway.provider);
  const access = new AccessService(new FileProxyTokenStore(home, graph.lock), graph.random, new NodeHash());
  const models = new ListModelsService(providers);
  const describe = new DescribeModelsService(models, graph.reference);
  const refresh = new RefreshModelsService(providers, graph.reference, describe);
  const opencode = new OpencodeConfigCodec();
  const origin: ClientOrigin = {
    origin: `http://${LOOPBACK_HOST}:${graph.config.port}`,
    // Absolute, so opencode can spawn it from any directory (rule O5).
    tokenCommand: [...entry, "token"],
  };
  const health = new HealthService(graph.enabled);
  const errors = new LoggingErrorReporter(graph.logger);
  const routes = new RouteHandler(
    [new AnthropicCodec(), new OpenAiCodec(), new GeminiCodec()],
    { access, passthrough: new PassthroughService(providers, graph.config.aliases), health, describe, refresh, opencode, origin },
    errors,
  );
  const log = graph.exchangeLog;
  const handler = log !== undefined ? new LoggingHttpHandler(routes, new ClientExchangeService(log.sink, log.scope, graph.clock, graph.random)) : routes;
  return { handler, errors, refresh, ports: { models: describe, opencode, origin, access, health } };
}

export async function buildCli(options: ContainerOptions): Promise<{ readonly config: ProxyConfig; readonly driver: Driver; readonly closeLogs: () => Promise<void> }> {
  const graph = await buildGraph(options);
  const clients: OAuthClientPort[] = [];
  const reporters: UsageReporterPort[] = [];
  for (const wired of [graph.claude, graph.antigravity, graph.openai]) if (wired !== undefined) clients.push(wired.oauth);
  if (graph.antigravity) reporters.push(graph.antigravity.quota);
  const keyClients: ApiKeyLoginPort[] = [];
  const devices: DeviceLoginClientPort[] = [];
  for (const gateway of graph.gateways) {
    if (gateway.oauth) clients.push(gateway.oauth);
    keyClients.push(gateway.keyLogin);
    if (gateway.device) devices.push(gateway.device);
    if (gateway.quota) reporters.push(gateway.quota);
  }

  const log = graph.exchangeLog;
  const login = new LoginService({
    clients,
    devices,
    keyClients,
    servers: log !== undefined ? new LoggingCallbackServerFactory(new LoopbackCallbackServerFactory(), log.sink, graph.clock, graph.random) : new LoopbackCallbackServerFactory(),
    browser: log !== undefined ? new LoggingBrowserLauncher(options.browser, log.sink, graph.random) : options.browser,
    manual: new TerminalManualCode(options.stdin, options.stdout),
    secrets: new TerminalSecretPrompt(options.stdin, options.stdout),
    store: graph.store,
    random: graph.random,
    hash: new NodeHash(),
    clock: graph.clock,
    timer: graph.timer,
    logger: graph.logger,
  });
  const { handler, errors, refresh, ports } = buildRoutes(graph, options.home, options.entry);
  const daemonUrl = `http://${LOOPBACK_HOST}:${graph.config.port}`;
  const server = new NodeHttpServer(handler, { host: options.listenHost, port: graph.config.port, maxBodyBytes: MAX_BODY_BYTES }, errors);
  const spend = new SpendReportService(new SpendLogReader(logsDirectoryOf(options.accounts.path)), () => graph.clock.now());
  const commands = proxyCommands(
    {
      login,
      accounts: new AccountAdminService(graph.store),
      usage: new UsageService(graph.enabled, reporters),
      ...ports,
      refresh: new RequestModelRefreshService(graph.transport, ports.access, daemonUrl, refresh),
      status: new DaemonStatusService(graph.transport, daemonUrl),
      spend,
      costSeams: costSeamsOf(graph.clock.now),
    },
    { server, shutdown: options.shutdown, console: new DaemonConsoleService(graph.console), models: new WarmModelsService(graph.modelLists) },
  );
  const driver = new CommandLineDriver(commands, PROGRAM, options.out, options.err);
  return { config: graph.config, driver, closeLogs: graph.closeLogs };
}

/** The command's seams over the real process: the clock, a real sleep, `notify-send` and the `opencode` binary. */
export function costSeamsOf(now: () => number): CostSeams {
  return {
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reconcile: reconcileWithOpencode,
    notify: (title, body) => {
      try {
        // `exited` always resolves with a code and a failed spawn throws here (measured on Bun 1.4.2), so nothing waits.
        void Bun.spawn(["notify-send", title, body], { stdout: "ignore", stderr: "ignore" }).exited;
      } catch {
        // a host without a notification daemon still gets the status line on stdout
      }
    },
  };
}

/** `opencode stats`' own estimate, capped at 20 s; never fatal for the cost report. */
const RECONCILE_TIMEOUT_MS = 20_000;

async function reconcileWithOpencode(days: number): Promise<ReconcileOutcome> {
  try {
    const child = Bun.spawn(["opencode", "stats", "--days", `${days}`, "--cost", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      // The cap is the spawn's own signal: Bun kills the process at the deadline (measured: exit 143), so `exited` below
      // answers `unreadable` instead of the report waiting on a hung client.
      signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
    });
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    if (code !== 0) return { skipped: "unreadable" };
    const parsed = JSON.parse(text) as { cost?: number };
    return typeof parsed.cost === "number" ? { estimate: parsed.cost, days } : { skipped: "unreadable" };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? { skipped: "not-found" } : { skipped: "unreadable" };
  }
}

/** The proxy's command tree: every command over the inbound ports it drives. */
export function proxyCommands(ports: CliPorts, daemon: CliDaemon): CliCommand {
  return new CommandRoot(PROXY_HELP, [
    new LoginCommand(ports.login),
    new AccountCommand([new AccountListCommand(ports.accounts), new AccountUseCommand(ports.accounts), new AccountRemoveCommand(ports.accounts)]),
    new QuotaCommand(ports.usage),
    new ModelsCommand(ports.models, ports.refresh),
    new OpencodeConfigCommand(ports.models, ports.opencode, ports.origin),
    new ServeCommand(daemon, ports.access, ports.health),
    new TokenCommand(ports.access),
    new StatusCommand(ports.status),
    new CostCommand(ports.spend, ports.costSeams),
    new HelpCommand(PROXY_HELP, PROGRAM, HELP_HELP),
  ]);
}

/** Builds and runs the CLI; configuration and store errors are reported, never thrown. */
export async function runCli(argv: readonly string[], options: ContainerOptions): Promise<number> {
  let cli: Awaited<ReturnType<typeof buildCli>>;
  try {
    cli = await buildCli(options);
  } catch (error) {
    options.err(`error: ${errorMessage(error)}\n`);
    return 1;
  }
  try {
    return await cli.driver.run(argv);
  } finally {
    await cli.closeLogs();
  }
}

/** Production entry: real home, terminal, network and process signals (seams only from the hermetic variables). */
export async function main(argv: readonly string[]): Promise<number> {
  const err = (text: string) => void process.stderr.write(text);
  let seams: UpstreamSeams;
  let hooks: TestHooks;
  const home = defaultHome(process.env, process.argv[1]!);
  let accountsFile: string;
  try {
    seams = seamsFrom(process.env);
    hooks = hooksFrom(process.env, seams);
    accountsFile = accountsFileOf(process.env, home);
  } catch (error) {
    err(`error: ${errorMessage(error)}\n`);
    return 1;
  }
  return runCli(argv, {
    home,
    accounts: { path: accountsFile, fs: hooks.accountsEdited !== undefined ? editedAccountsFs(nodeFs, accountsFile, hooks.accountsEdited) : nodeFs },
    entry: tokenEntry(process.env, home, process.execPath, process.argv.slice(1, 2)),
    out: (text) => process.stdout.write(text),
    err,
    stdin: process.stdin,
    stdout: process.stdout,
    seams,
    transport: new FetchTransport(fetch as unknown as FetchFunction, hooks.upstreamIdleMs ?? UPSTREAM_IDLE_TIMEOUT_MS),
    browser: new SystemBrowserLauncher(hooks.platform ?? process.platform),
    shutdown: new ProcessShutdownSignal(),
    listenHost: hooks.listenUnassigned ? UNASSIGNED_TEST_HOST : LOOPBACK_HOST,
    lock: {
      options: { ...DEFAULT_LOCK_OPTIONS, timeoutMs: hooks.lockTimeoutMs ?? DEFAULT_LOCK_OPTIONS.timeoutMs },
      fs: hooks.lockStatVanishes ? vanishingStatFs(nodeFs) : nodeFs,
    },
  });
}
