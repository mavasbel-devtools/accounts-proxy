// `quota <provider>`, `models [<provider>] [--json]` and `opencode-config`: what the providers offer and report.
import type { CatalogSource } from "@accounts-proxy/core/domain/models.ts";
import type { UsagePort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import type { OpencodeConfigPort, OpencodeOrigin } from "@accounts-proxy/core/ports/inbound/opencode.ts";
import type { DescribeModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
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
  synopsis: ["models [<provider>] [--json]"],
  summary: "each provider's models and where the list came from",
  description: [
    "One block per enabled provider: its models with the context and output limits a source states, and where the list came from (live catalog, stored copy, built-in list, or unavailable with the reason). With a provider, only that provider.",
  ],
  arguments: [{ name: "<provider>", text: `${PROVIDER_ARGUMENT.text} (default: every enabled provider)` }],
  options: [{ name: "--json", text: "print the detailed records of GET /proxy/v1/models, every field with its source (default: the text list)" }],
  exits: [{ name: "0", text: "the catalogs were printed" }, FAILED_EXIT, USAGE_EXIT],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy models", text: "every enabled provider's models" },
    { name: "bun run proxy models claude --json", text: "Claude's models with every detail and its source" },
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

export class ModelsCommand extends CliCommand {
  readonly help = MODELS_HELP;

  constructor(private readonly models: DescribeModelsPort) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    const json = args.includes("--json");
    const names = args.filter((a) => a !== "--json");
    if (names.length > 1 || args.length - names.length > 1) throw new UsageError("models takes at most one provider and --json");
    const catalogs = await this.models.describeModels(names[0] === undefined ? undefined : providerArgument(names[0], "models"));
    if (json) {
      out(`${JSON.stringify({ catalogs }, null, 2)}\n`);
      return;
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
    private readonly origin: OpencodeOrigin,
  ) {
    super();
  }

  async run(args: readonly string[], out: Writer): Promise<void> {
    noArguments(args, "opencode-config");
    out(`${JSON.stringify(this.opencode.config(await this.models.describeModels(), this.origin), null, 2)}\n`);
  }
}
