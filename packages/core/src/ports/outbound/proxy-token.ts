/** Durable storage of the proxy token (`<data>/token`, owner-only). */
export abstract class ProxyTokenStorePort {
  /** The stored token, or undefined when none exists yet. */
  abstract read(): Promise<string | undefined>;
  abstract write(token: string): Promise<void>;
}
