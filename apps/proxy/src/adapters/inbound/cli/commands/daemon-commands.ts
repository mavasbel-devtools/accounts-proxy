// `serve`, `token` and `status`: the daemon, its access token and whether it answers.
import type { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import type { DaemonConsolePort, DaemonStatusPort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import type { HealthPort, WarmModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { CliCommand, type CommandHelp, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { HOME_VARIABLE, noArguments, PROGRAM, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";
import type { Server, ShutdownSignal } from "@accounts-proxy/proxy/adapters/inbound/server.ts";

/** In-flight responses get this long to finish after SIGINT/SIGTERM (P4 plan §2.1). */
export const SHUTDOWN_GRACE_MS = 10_000;

/** What `serve` runs: the socket server until the process is asked to stop. */
export type CliDaemon = { readonly server: Server; readonly shutdown: ShutdownSignal; readonly console: DaemonConsolePort; readonly models: WarmModelsPort };

export const SERVE_HELP: CommandHelp = {
  name: "serve",
  synopsis: ["serve"],
  summary: "run the daemon in the foreground (Ctrl-C stops it)",
  description: [
    `Listens on 127.0.0.1 at the port of proxy.yaml (default 4141) and serves every enabled provider. Every route except /health and /.well-known/opencode needs the proxy token (\`token\`). Ctrl-C (SIGINT) or SIGTERM stops it; in-flight responses get ${SHUTDOWN_GRACE_MS} ms (${SHUTDOWN_GRACE_MS / 1000} s) to finish. A port in use is fatal.`,
    "Once it listens it prints, on stdout, every line it writes to <data>/logs/proxy.log (the usage exchange records go only to <data>/logs/*-usage.*.jsonl). The files are written as well.",
  ],
  exits: [{ name: "0", text: "stopped by SIGINT or SIGTERM" }, { name: "1", text: "the configuration is invalid or the port could not be bound: `error: <message>` on stderr" }, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy serve", text: "run the daemon on 127.0.0.1:4141" },
    { name: "ACCOUNTS_PROXY_HOME=/tmp/opencode/ap-test bun run proxy serve", text: "run a separate daemon with its own data directory (its own proxy.yaml and accounts)" },
  ],
};

export const TOKEN_HELP: CommandHelp = {
  name: "token",
  synopsis: ["token"],
  summary: "print the proxy token clients send (created on first use)",
  description: [
    "Clients send it as their API key: `Authorization: Bearer <token>`, `x-api-key`, `x-goog-api-key` or `?key=`. It is stored in <data>/token.json (0600) and compared in constant time.",
  ],
  exits: [{ name: "0", text: "the token was printed" }, { name: "1", text: "token.json is damaged or cannot be written: `error: <message>` on stderr" }, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy token", text: "print the token" },
    { name: "export ACCOUNTS_PROXY_TOKEN=\"$(bun run --silent proxy token)\"", text: "keep it in the variable the opencode configuration reads" },
  ],
};

export const STATUS_HELP: CommandHelp = {
  name: "status",
  synopsis: ["status"],
  summary: "check whether the daemon answers on the configured port",
  description: [
    "Calls GET /health on 127.0.0.1 at the configured port: `running at <url> (providers: ...)`, or `not running at <url> (<reason>)`.",
  ],
  exits: [{ name: "0", text: "the daemon answered" }, { name: "1", text: "nothing answered, or the configuration is invalid" }, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy status", text: "is the daemon running?" },
    { name: "bun run proxy status || bun run proxy serve", text: "start the daemon only when it is not running" },
  ],
};

export class ServeCommand extends CliCommand {
  readonly help = SERVE_HELP;

  constructor(
    private readonly daemon: CliDaemon,
    private readonly access: AccessPort,
    private readonly health: HealthPort,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "serve");
    await this.access.token();
    const listening = await this.daemon.server.start();
    const providers = this.health.enabledProviders();
    out(`accounts-proxy listening on http://${listening.host}:${listening.port} (providers: ${providers.join(", ") || "none"})\n`);
    out(`clients authenticate with the proxy token: ${PROGRAM} token\n`);
    this.daemon.console.attach();
    // The model lists are fetched once now, all at the same time; requests meanwhile join these fetches (M2).
    const warming = this.daemon.models.warm();
    const signal = await this.daemon.shutdown.wait();
    out(`${signal}: stopping (in-flight responses get ${SHUTDOWN_GRACE_MS / 1000} s)\n`);
    await this.daemon.server.stop(SHUTDOWN_GRACE_MS);
    await warming;
    out("stopped\n");
  }
}

export class TokenCommand extends CliCommand {
  readonly help = TOKEN_HELP;

  constructor(private readonly access: AccessPort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "token");
    out(`${await this.access.token()}\n`);
  }
}

export class StatusCommand extends CliCommand {
  readonly help = STATUS_HELP;

  constructor(private readonly status: DaemonStatusPort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<number | void> {
    noArguments(args, "status");
    const status = await this.status.status();
    if (status.running) {
      out(`running at ${status.url} (providers: ${status.providers.join(", ") || "none"})\n`);
      return;
    }
    out(`not running at ${status.url} (${status.reason})\n`);
    return 1;
  }
}
