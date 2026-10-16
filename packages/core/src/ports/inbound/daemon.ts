import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";

export type DaemonStatus =
  | { readonly running: true; readonly url: string; readonly providers: readonly ProviderId[] }
  | { readonly running: false; readonly url: string; readonly reason: string };

/** `accounts-proxy status`: whether a daemon answers `GET /health` on the configured port. */
export abstract class DaemonStatusPort {
  abstract status(): Promise<DaemonStatus>;
}
