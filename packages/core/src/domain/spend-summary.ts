// The spend report's arithmetic (plan 2026-11-06-15-21, stage 2): pure aggregation of the exchanges the usage log
// records, with the two derived figures the report exists for — dollars per million output tokens and cache share.

/** One completed exchange, as the usage log records it. */
export type SpendEntry = {
  /** When the answer ended, epoch milliseconds. */
  readonly at: number;
  /** The upstream that served the exchange, as it named itself in the stream. */
  readonly provider: string;
  readonly model: string;
  /** What the upstream charged, in US dollars. */
  readonly cost: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
};

/** `from` inclusive, `until` exclusive, epoch milliseconds. */
export type SpendWindow = { readonly from: number; readonly until: number };

export type SpendTotals = {
  readonly cost: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** Σcost / Σoutput, in dollars per million output tokens; 0 when no output was produced. */
  readonly perMillionOutput: number;
  /** Σcached / Σprompt; 0 when no prompt tokens were read. */
  readonly cacheShare: number;
  readonly exchanges: number;
};

export type SpendGroup = { readonly key: string; readonly totals: SpendTotals };

export type SpendSummary = { readonly totals: SpendTotals; readonly groups: readonly SpendGroup[] };

export type SpendGroupBy = "provider" | "model" | "day";

/** An entry the log could not have produced: cached tokens are a subset of the prompt tokens. */
export class InvalidSpendEntryError extends Error {}

export const EMPTY_TOTALS: SpendTotals = { cost: 0, promptTokens: 0, outputTokens: 0, cachedTokens: 0, perMillionOutput: 0, cacheShare: 0, exchanges: 0 };

const totalsOf = (entries: readonly SpendEntry[]): SpendTotals => {
  let cost = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for (const entry of entries) {
    cost += entry.cost;
    promptTokens += entry.promptTokens;
    outputTokens += entry.outputTokens;
    cachedTokens += entry.cachedTokens;
  }
  return {
    cost,
    promptTokens,
    outputTokens,
    cachedTokens,
    perMillionOutput: outputTokens === 0 ? 0 : (cost / outputTokens) * 1_000_000,
    cacheShare: promptTokens === 0 ? 0 : cachedTokens / promptTokens,
    exchanges: entries.length,
  };
};

const keyOf = (entry: SpendEntry, by: SpendGroupBy): string => (by === "day" ? new Date(entry.at).toISOString().slice(0, 10) : entry[by]);

/** The totals of every entry, plus one row per group, ordered by cost descending and then by key. */
export function summarizeSpend(entries: readonly SpendEntry[], by: SpendGroupBy): SpendSummary {
  for (const entry of entries) {
    if (entry.cachedTokens > entry.promptTokens) {
      throw new InvalidSpendEntryError(`cached tokens ${entry.cachedTokens} exceed prompt tokens ${entry.promptTokens}`);
    }
  }
  const grouped = new Map<string, SpendEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry, by);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [entry]);
    else bucket.push(entry);
  }
  const groups = [...grouped].map(([key, bucket]) => ({ key, totals: totalsOf(bucket) }));
  // Keys are unique by construction (they come from a Map), so the comparison never has to answer "equal".
  groups.sort((a, b) => b.totals.cost - a.totals.cost || (a.key < b.key ? -1 : 1));
  return { totals: totalsOf(entries), groups };
}
