// The router token (plan D6): every route except GET /health requires it.

export abstract class AccessPort {
  /** The router token, created on first use. */
  abstract token(): Promise<string>;
  /** Constant-time check of a presented token; `undefined` (no token presented) is always refused. */
  abstract authorize(candidate: string | undefined): Promise<boolean>;
}
