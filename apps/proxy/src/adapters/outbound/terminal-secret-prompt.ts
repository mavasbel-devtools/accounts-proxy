// Hidden API-key prompt (plan P4.6 N4): the question goes to the terminal and the typed key is not echoed. On a TTY,
// readline runs in terminal mode (raw input, so the terminal itself does not echo) and writes its own echo to a
// discarding stream; a piped stdin is read as a plain line.
import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";
import { SecretPromptPort } from "@accounts-proxy/core/ports/outbound/api-key.ts";
import { readLine } from "@accounts-proxy/proxy/adapters/outbound/read-line.ts";

export class TerminalSecretPrompt extends SecretPromptPort {
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    super();
  }

  async prompt(question: string): Promise<string> {
    const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
    const rl = createInterface({ input: this.input, output: silent, terminal: (this.input as { isTTY?: boolean }).isTTY === true });
    try {
      this.output.write(question);
      const answer = await readLine(rl, "");
      this.output.write("\n");
      return answer;
    } finally {
      rl.close();
    }
  }
}
