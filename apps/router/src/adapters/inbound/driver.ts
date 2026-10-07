/** A driving (inbound) adapter that runs to completion and reports a process exit code. */
export abstract class Driver {
  abstract run(argv: readonly string[]): Promise<number>;
}
