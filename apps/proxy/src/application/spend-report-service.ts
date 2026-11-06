// The spend report over the exchange log (plan 2026-11-06-15-21, stage 4): resolve the window, read it, summarize it,
// and say whether retention left the answer complete.
import { summarizeSpend } from "@accounts-proxy/core/domain/spend-summary.ts";
import { SpendReportPort, type SpendQuery, type SpendReport } from "@accounts-proxy/core/ports/inbound/spend.ts";
import type { SpendLogPort } from "@accounts-proxy/core/ports/outbound/spend-log.ts";

/** Local midnight of an ISO date, and the midnight that follows it. */
const dayWindow = (day: string): { from: number; until: number } => {
  const from = new Date(`${day}T00:00:00`).getTime();
  const until = new Date(`${day}T00:00:00`);
  until.setDate(until.getDate() + 1);
  return { from, until: until.getTime() };
};

/** The local calendar date of an instant, `YYYY-MM-DD`. */
const localDay = (at: number): string => {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const todayWindow = (now: number): { from: number; until: number } => dayWindow(localDay(now));

export class SpendReportService extends SpendReportPort {
  constructor(
    private readonly log: SpendLogPort,
    private readonly now: () => number,
  ) {
    super();
  }

  async report(query: SpendQuery): Promise<SpendReport> {
    const window = query.day !== undefined ? dayWindow(query.day) : resolveWindow(query, this.now());
    const read = await this.log.read(window);
    const summary = summarizeSpend(read.entries, query.by);
    const covered = read.covered ?? { from: window.from, until: window.from };
    return {
      window,
      coverage: covered.from <= window.from ? "complete" : "partial",
      covered,
      summary,
      malformed: read.malformed,
    };
  }
}

/** `since`/`until` as given, each defaulting to the start of today or the current instant. */
function resolveWindow(query: SpendQuery, now: number): { from: number; until: number } {
  const today = todayWindow(now);
  return { from: query.since ?? today.from, until: query.until ?? now };
}
