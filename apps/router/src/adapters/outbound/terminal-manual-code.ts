// Headless paste-code prompt (login --manual): prints the authorization URL and reads one line.
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { ManualCodePort } from "@inference-router/core/ports/outbound/oauth.ts";

export class TerminalManualCode extends ManualCodePort {
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {
    super();
  }

  /** The URL itself is announced by the caller (LoginOptions.onAuthorizeUrl); only the instruction is printed here. */
  async prompt(_authorizeUrl: string): Promise<string> {
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    try {
      this.output.write("Approve in the browser, then paste the code shown on the page.\n");
      return await rl.question("code> ");
    } finally {
      rl.close();
    }
  }
}
