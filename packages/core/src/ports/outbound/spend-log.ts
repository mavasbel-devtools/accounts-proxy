// The exchange log as a source of spend (plan 2026-11-06-15-21): the application reads entries, never files.
import type { SpendEntry, SpendWindow } from "@accounts-proxy/core/domain/spend-summary.ts";

export type SpendLogRead = {
  readonly entries: readonly SpendEntry[];
  /** Lines that were not valid JSON or lacked the fields a spend needs. */
  readonly malformed: number;
  /** The span of the files that were read; `undefined` when there was none. */
  readonly covered: SpendWindow | undefined;
};

export abstract class SpendLogPort {
  abstract read(window: SpendWindow): Promise<SpendLogRead>;
}
