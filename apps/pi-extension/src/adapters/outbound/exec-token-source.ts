// Runs the manifest's token command (architecture design §5): the execFile function given to the
// constructor (node:child_process execFile in composition; no shell), 10000 ms timeout, trimmed stdout.
import { TokenSourcePort } from "@accounts-proxy/pi-extension/ports/outbound/token-source.ts";

/** The slice of execFile the token source uses. util.promisify(execFile) satisfies it. */
export type ExecFileFn = (file: string, args: string[], options: { readonly timeout: number }) => Promise<{ readonly stdout: string }>;

export class ExecTokenSource extends TokenSourcePort {
  constructor(private readonly execFileFn: ExecFileFn) {
    super();
  }

  async token(command: readonly string[]): Promise<string> {
    const out = await this.execFileFn(command[0]!, [...command.slice(1)], { timeout: 10000 });
    const token = out.stdout.trim();
    if (token === "") throw new Error("token command printed nothing");
    return token;
  }
}
