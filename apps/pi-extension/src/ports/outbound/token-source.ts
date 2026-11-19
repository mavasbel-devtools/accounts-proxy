// How the extension obtains a proxy token (architecture design §5): by running the manifest's command.
export abstract class TokenSourcePort {
  /** Run command and return its trimmed stdout; rejects on failure or empty output. */
  abstract token(command: readonly string[]): Promise<string>;
}
