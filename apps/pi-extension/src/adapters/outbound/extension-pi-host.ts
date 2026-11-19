// pi's side of the extension (architecture design §5): adapts pi's ExtensionAPI, stderr and the
// environment. No imports: every capability is injected (pi's process provides them in composition).
import { PiHostPort, type PiProviderConfig } from "@accounts-proxy/pi-extension/ports/outbound/pi-host.ts";

/** The slice of pi's ExtensionAPI the host uses (method shorthand, like pi's own declaration). */
export type PiExtensionApi = {
  registerProvider(id: string, config: PiProviderConfig): void;
};

/** The slice of process.env the host uses. */
export type EnvVars = Record<string, string | undefined>;

/** The slice of process.stderr the host uses. */
export type StderrWriter = { write(message: string): void };

export class ExtensionPiHost extends PiHostPort {
  constructor(
    private readonly api: PiExtensionApi,
    private readonly env: EnvVars,
    private readonly stderr: StderrWriter,
  ) {
    super();
  }

  registerProvider(id: string, config: PiProviderConfig): void {
    this.api.registerProvider(id, config);
  }

  warn(message: string): void {
    this.stderr.write(`${message}\n`);
  }

  readEnv(name: string): string | undefined {
    return this.env[name];
  }

  setEnv(name: string, value: string): void {
    this.env[name] = value;
  }
}
