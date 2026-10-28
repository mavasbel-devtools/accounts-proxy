/** Durable storage of the proxy token (`<data>/token`, owner-only). */
export abstract class ProxyTokenStorePort {
  /** The stored token, or undefined when none exists yet. */
  abstract read(): Promise<string | undefined>;
  /** Stores `token` unless a token exists by now; returns the stored one (atomic across processes). */
  abstract createIfAbsent(token: string): Promise<string>;
}
