// `login <provider>`: signs in (browser, device code or API key) and makes the account the active one.
import type { LoginPort } from "@accounts-proxy/core/ports/inbound/accounts.ts";
import { CliCommand, type CommandHelp, UsageError, type Writer } from "@accounts-proxy/proxy/adapters/inbound/cli/command.ts";
import { FAILED_EXIT, HOME_VARIABLE, providerArgument, PROVIDER_ARGUMENT, USAGE_EXIT } from "@accounts-proxy/proxy/adapters/inbound/cli/commands/arguments.ts";

export const DEFAULT_LOGIN_TIMEOUT_S = 300;

export const LOGIN_HELP: CommandHelp = {
  name: "login",
  synopsis: ["login <provider> [--manual] [--new] [--key] [--timeout-seconds N]"],
  summary: "sign in to a provider and make the account the active one",
  description: [
    "The sign-in method depends on the provider: a browser sign-in with a loopback listener on 127.0.0.1 (claude, antigravity, openai, openrouter; the URL is printed too, in case the browser does not open), the OpenCode Console device login (opencode, opencode-go share one account: the code is printed and the approval page opened), or an API key typed at a hidden prompt (cheaper-inference). The account is stored only in the accounts file (`<data directory>/accounts.json`), owner-only (0600).",
  ],
  arguments: [PROVIDER_ARGUMENT],
  options: [
    { name: "--manual", text: "paste the code from the provider's page instead of the loopback listener (claude, openrouter; default: off)" },
    { name: "--new", text: "register a new ChatGPT account instead of re-authorizing the active one (openai; default: off)" },
    { name: "--key", text: "enter an API key at a hidden prompt instead of signing in (gateways; default: off)" },
    { name: "--timeout-seconds N", text: `how long to wait for the sign-in, a positive integer (default: ${DEFAULT_LOGIN_TIMEOUT_S})` },
  ],
  exits: [
    { name: "0", text: "signed in; the account is the active one" },
    FAILED_EXIT,
    USAGE_EXIT,
  ],
  environment: [HOME_VARIABLE],
  examples: [
    { name: "bun run proxy login claude", text: "sign in to Claude in the browser" },
    { name: "bun run proxy login claude --manual --timeout-seconds 600", text: "paste the code from the page instead, waiting up to 10 minutes" },
    { name: "bun run proxy login openai --new", text: "register another ChatGPT account; it becomes the active one" },
    { name: "bun run proxy login opencode", text: "the OpenCode Console device login (also used by opencode-go)" },
    { name: "bun run proxy login openrouter --key", text: "store an OpenRouter API key typed at a hidden prompt" },
  ],
};

export class LoginCommand extends CliCommand {
  readonly help = LOGIN_HELP;

  constructor(private readonly login: LoginPort) {
    super();
  }

  async run(argv: readonly string[], out: Writer): Promise<void> {
    const args = [...argv];
    const id = providerArgument(args.shift(), "login");
    let manual = false;
    let fresh = false;
    let key = false;
    let timeoutS = DEFAULT_LOGIN_TIMEOUT_S;
    while (args.length > 0) {
      const flag = args.shift();
      if (flag === "--manual") manual = true;
      else if (flag === "--new") fresh = true;
      else if (flag === "--key") key = true;
      else if (flag === "--timeout-seconds") {
        const value = Number(args.shift());
        if (!Number.isInteger(value) || value < 1) throw new UsageError("--timeout-seconds needs a positive integer");
        timeoutS = value;
      } else throw new UsageError(`unknown login option ${flag}`);
    }
    const account = await this.login.login(id, {
      manual,
      fresh,
      key,
      timeoutMs: timeoutS * 1000,
      onAuthorizeUrl: (url) => out(`${manual ? "Open" : "Opening your browser. If it does not open, visit"}:\n${url}\n`),
      onUserCode: (code) => out(`Confirm this code on the page: ${code}\n`),
    });
    out(`signed in to ${account.provider} as ${account.label} (active account)\n`);
  }
}
