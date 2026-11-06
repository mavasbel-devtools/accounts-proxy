# Product design — `accounts-proxy cost` (spend report)

Plan: `/home/mavasbel/.opencode/plan/2026-11-06-15-21-accounts-proxy-cost-command.md`.

## 1. Purpose

OpenCode's `stats` command multiplies tokens by the model's catalogue price. The proxy records, per
exchange, what the upstream actually charged (`usage.raw.cost` in `*-usage.*.jsonl`). Nothing joins the
two, so a day that looks like `$2.35` in `opencode stats --cost` can be `$0.29` upstream after
`service_tier: flex` was applied (measured 2026-11-06, 432 exchanges, `$1.506/M` output).

The feature answers four questions from the data the proxy already writes:

1. What did I spend today, and at what price per million output tokens?
2. What did I spend in an explicit window, split by provider, model or day?
3. Is the figure complete, or has retention removed files it needed?
4. Am I approaching a daily or monthly ceiling, before the month ends?

## 2. Use cases

Every use case carries a positive and a negative scenario. Tags: `feature=spend-report`,
`use-case=uc-N`, `dependency=none|opencode`.

### uc-1 — Today's spend, human readable

- **Given** today's usage log files exist, **when** `cost` runs with no arguments, **then** it prints the
  total dollars, the blended `$` per million output tokens, the cache share, the exchange count and one
  row per provider.
- **Negative:** the logs directory is empty → prints `$0.000`, `0 exchanges`, coverage `complete` for the
  empty window, exit `0` (an empty window is not an error).

### uc-2 — Explicit window, filters and JSON

- **Given** several days of logs, **when** `cost --day 2026-11-06 --by model --json` runs, **then** only
  that day's exchanges are aggregated, grouped by model, emitted as JSON with the totals and groups.
- **Negative:** `--day 2026-13-40` (invalid date) → usage error, exit `2`, nothing printed on stdout.

### uc-3 — Partial window under retention

- **Given** the oldest retained log file is newer than the requested window start, **when** `cost --since
  2026-11-01` runs, **then** the report is marked `partial` and prints the range actually covered.
- **Negative:** every file is older than the window → `0 exchanges`, coverage `partial`, covered range
  printed, exit `0`.

### uc-4 — Reconciliation with `opencode stats`

- **Given** the `opencode` executable is on `PATH`, **when** `cost --reconcile` runs, **then** it prints
  the OpenCode estimate, the upstream actual and the delta percentage.
- **Negative:** `opencode` is absent or does not answer within 20 s → prints `reconciliation skipped`
  (`not found`) or `reconciliation timed out`, exit `0` for the report itself.

### uc-5 — Watch with budgets

- **Given** a daily ceiling of `$5`, **when** `cost --watch 30 --budget-daily 5` runs and the day's spend
  crosses it, **then** the status line is printed every 30 s and the process exits `4` on the first
  breach.
- **Negative:** a negative budget value → usage error, exit `2`.

## 3. Command surface

```
bun run proxy cost [--day YYYY-MM-DD | --since YYYY-MM-DD [--until YYYY-MM-DD]]
                   [--by provider|model|day] [--json] [--reconcile]
                   [--watch SECONDS] [--budget-daily USD] [--budget-monthly USD]
```

| exit | meaning |
|---|---|
| `0` | the report was printed (including an empty or partial window) |
| `1` | the logs could not be read |
| `2` | usage error |
| `4` | a budget ceiling was crossed (watch mode) |

`3` is never used: it already means "tier incomplete" in `scripts/gate/run-tests.ts`.

## 4. Data and states

- **Entry:** `at`, `provider`, `model`, `cost`, `promptTokens`, `outputTokens`, `cachedTokens`.
- **Window:** `from` inclusive, `until` exclusive, epoch milliseconds.
- **Coverage:** `complete` when the earliest retained file is at or before the window start; otherwise
  `partial`, with the range actually covered.
- **Grouping:** `provider`, `model` or `day` (UTC date of `at`).

## 5. Acceptance criteria

Each scenario in §2 is implemented in `apps/proxy/tests/component/spend-report-service.test.ts`
(uc-1…uc-4), `apps/proxy/tests/component/cost-watch.test.ts` (uc-5) and
`apps/proxy/tests/live/cost-reconcile.test.ts` (uc-4 against the real `opencode` binary).
