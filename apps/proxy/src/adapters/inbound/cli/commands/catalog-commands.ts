// `quota <provider>`, `models [<provider>] [--json] [--refresh]`, `opencode-config` and `pi-config`: what the providers offer and report.
import type { CatalogSource } from "@accounts-proxy/core/domain/models.ts";
import type { UsagePort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { ClientOrigin } from "@accounts-proxy/core/ports/inbound/client-origin.ts";
import type { OpencodeConfigPort } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import type { PiConfigPort } from "@accounts-proxy/core/ports/inbound/pi.ts";
import type { DescribeModelsPort, RequestModelRefreshPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import { CliCommand, type CommandHelp, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { FAILED_EXIT, HOME_VARIABLE, noArguments, providerArgument, PROVIDER_ARGUMENT, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";

export const QUOTA_HELP: CommandHelp = {
  name: "quota",
  synopsis: ["quota <provider>"],
  summary: "the remaining quota, as the provider reports it",
  description: [
    "antigravity: per model group; openrouter: the key's usage and limit; cheaper-inference: the wallet. Any other provider does not report usage. The provider must be enabled in proxy.yaml and signed in.",
  ],
  arguments: [PROVIDER_ARGUMENT],
  exits: [{ name: "0", text: "the report was printed" }, { name: "1", text: "the provider is disabled, reports no usage, or the request failed: `error: <message>` on stderr" }, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy quota antigravity", text: "the remaining quota of each Antigravity model group" },
    { name: "bun run proxy quota openrouter", text: "the OpenRouter key's usage and limit" },
  ],
};

export const MODELS_HELP: CommandHelp = {
  name: "models",
  synopsis: ["models [<provider>] [--json] [--refresh]"],
  summary: "each provider's models and where the list came from",
  description: [
    "One block per enabled provider: its models with the context and output limits a source states, and where the list came from (live catalog, stored copy, built-in list, or unavailable with the reason). With a provider, only that provider.",
    "A fetched list is reused for `modelListMaxAgeMinutes` of proxy.yaml (default 1440, 24 h). `--refresh` reads every list now from its source: the running daemon on the configured port does it (POST /proxy/v1/models/refresh), so its own lists and the opencode configuration change at once; with no daemon listening there, this command does it and rewrites the stored copies a daemon reads when it starts.",
  ],
  arguments: [{ name: "<provider>", text: `${PROVIDER_ARGUMENT.text} (default: every enabled provider)` }],
  options: [
    { name: "--json", text: "print the detailed records of GET /proxy/v1/models, every field with its source (default: the text list)" },
    { name: "--refresh", text: "read the lists now from their sources instead of reusing a copy younger than modelListMaxAgeMinutes (default: off)" },
  ],
  exits: [{ name: "0", text: "the catalogs were printed" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy models", text: "every enabled provider's models" },
    { name: "bun run proxy models claude --json", text: "Claude's models with every detail and its source" },
    { name: "bun run proxy models --refresh", text: "every list read now, by the running daemon when there is one" },
    { name: "bun run proxy models openrouter --refresh", text: "only OpenRouter's list read now" },
  ],
};

export const OPENCODE_CONFIG_HELP: CommandHelp = {
  name: "opencode-config",
  synopsis: ["opencode-config"],
  summary: "the opencode v2 configuration of every model (JSON)",
  description: [
    "The document GET /opencode/config.json serves: one `ap-<provider>` provider per enabled provider in opencode v2's `providers` schema, with the models, their limits and variants.",
  ],
  exits: [{ name: "0", text: "the configuration was printed" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy opencode-config", text: "print the configuration" },
    { name: "bun run proxy opencode-config > /tmp/opencode/ap-config.json", text: "save it to a file" },
  ],
};

export const PI_CONFIG_HELP: CommandHelp = {
  name: "pi-config",
  synopsis: ["pi-config"],
  summary: "the pi models.json document of every model (JSON)",
  description: [
    "The document GET /pi/models.json serves: one `ap-<provider>` provider per enabled provider in pi's `models.json` schema, with the models, their limits and variants.",
  ],
  exits: [{ name: "0", text: "the configuration was printed" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy pi-config", text: "print the configuration" },
    { name: "bun run proxy pi-config > /tmp/pi/models.json", text: "save it to a file" },
  ],
};

const SOURCE_TEXT: Readonly<Record<CatalogSource, string>> = {
  live: "live catalog",
  cache: "stored copy of the live catalog",
  static: "built-in list",
  unavailable: "unavailable",
};

export class QuotaCommand extends CliCommand {
  readonly help = QUOTA_HELP;

  constructor(private readonly usage: UsagePort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const provider = providerArgument(args[0], "quota");
    if (args.length > 1) throw new UsageError("quota takes one provider");
    out(`${(await this.usage.usage(provider)).text}\n`);
  }
}

const MODELS_OPTIONS: readonly string[] = ["--json", "--refresh"];

export class ModelsCommand extends CliCommand {
  readonly help = MODELS_HELP;

  constructor(
    private readonly models: DescribeModelsPort,
    private readonly refresh: RequestModelRefreshPort,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const json = args.includes("--json");
    const refresh = args.includes("--refresh");
    const names = args.filter((a) => !MODELS_OPTIONS.includes(a));
    if (names.length > 1 || new Set(args).size !== args.length) throw new UsageError("models takes at most one provider, --json and --refresh");
    const provider = names[0] === undefined ? undefined : providerArgument(names[0], "models");
    const outcome = refresh ? await this.refresh.request(provider) : undefined;
    const catalogs = outcome?.catalogs ?? (await this.models.describeModels(provider));
    if (json) {
      out(`${JSON.stringify(outcome === undefined ? { catalogs } : { refreshedBy: outcome.by, url: outcome.url, catalogs }, null, 2)}\n`);
      return;
    }
    if (outcome !== undefined) {
      out(
        outcome.by === "daemon"
          ? `refreshed by the daemon at ${outcome.url}\n`
          : `no daemon at ${outcome.url}: refreshed by this process (the stored copies a daemon reads when it starts)\n`,
      );
    }
    for (const catalog of catalogs) {
      out(`# ${catalog.provider}: ${catalog.models.length} models (${SOURCE_TEXT[catalog.source]}${catalog.error !== undefined ? `: ${catalog.error.message}` : ""})\n`);
      for (const m of catalog.models) {
        // Each limit only when a source states it (OpenAI's list names the context window only, live L0).
        const limits = [m.contextWindow !== undefined ? `context ${m.contextWindow}` : "", m.maxOutputTokens !== undefined ? `output ${m.maxOutputTokens}` : ""].filter((x) => x !== "").join(" / ");
        out(`${m.id}  ${m.name}${limits === "" ? "" : `  ${limits}`}\n`);
      }
    }
  }
}

export class OpencodeConfigCommand extends CliCommand {
  readonly help = OPENCODE_CONFIG_HELP;

  constructor(
    private readonly models: DescribeModelsPort,
    private readonly opencode: OpencodeConfigPort,
    private readonly origin: ClientOrigin,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "opencode-config");
    out(`${JSON.stringify(this.opencode.config(await this.models.describeModels(), this.origin), null, 2)}\n`);
  }
}

export class PiConfigCommand extends CliCommand {
  readonly help = PI_CONFIG_HELP;

  constructor(
    private readonly models: DescribeModelsPort,
    private readonly pi: PiConfigPort,
    private readonly origin: ClientOrigin,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "pi-config");
    out(`${JSON.stringify(this.pi.config(await this.models.describeModels(), this.origin), null, 2)}\n`);
  }
}
