/** Durable storage of the router token (`<data>/token`, owner-only). */
export abstract class RouterTokenStorePort {
  /** The stored token, or undefined when none exists yet. */
  abstract read(): Promise<string | undefined>;
  abstract write(token: string): Promise<void>;
}
