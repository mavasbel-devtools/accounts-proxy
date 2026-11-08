// The spend report (plan 2026-11-06-15-21): what `cost` asks for and what it gets back.
import type { SpendGroupBy, SpendSummary, SpendWindow } from "@accounts-proxy/core/domain/spend-summary.ts";

export type SpendQuery = {
  /** An ISO date, `YYYY-MM-DD`; overrides `since`/`until`. */
  readonly day?: string;
  /** Epoch milliseconds, inclusive. */
  readonly since?: number;
  /** Epoch milliseconds, exclusive. */
  readonly until?: number;
  readonly by: SpendGroupBy;
};

/** `complete` when every file of the window survived retention; `partial` when the oldest one is later. */
export type SpendCoverage = "complete" | "partial";

export type SpendReport = {
  readonly window: SpendWindow;
  readonly coverage: SpendCoverage;
  /** The span the log files actually covered. */
  readonly covered: SpendWindow;
  readonly summary: SpendSummary;
  /** Records the reader could not parse; never fatal. */
  readonly malformed: number;
};

export abstract class SpendReportPort {
  abstract report(query: SpendQuery): Promise<SpendReport>;
}
