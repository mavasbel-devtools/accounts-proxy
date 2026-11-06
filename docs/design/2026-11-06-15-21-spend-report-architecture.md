# Architecture design — `accounts-proxy cost` (spend report)

Plan: `/home/mavasbel/.opencode/plan/2026-11-06-15-21-accounts-proxy-cost-command.md`.
Product design: `docs/design/2026-11-06-15-21-spend-report-product.md`.

Dependency direction: `adapters → ports → domain` (`AGENTS.md` §2 of this repository).

## 1. Domain — `packages/core/src/domain/spend-summary.ts`

Serves uc-1, uc-2, uc-3. Pure functions, no I/O, no clock.

| name | responsibility |
|---|---|
| `SpendEntry` | one completed exchange: `at`, `provider`, `model`, `cost`, `promptTokens`, `outputTokens`, `cachedTokens` |
| `SpendWindow` | `from` (inclusive) and `until` (exclusive), epoch ms |
| `SpendTotals` | `cost`, token sums, `perMillionOutput`, `cacheShare`, `exchanges` |
| `SpendGroup` | one row of a grouping: `key` plus `SpendTotals` |
| `SpendSummary` | `totals` plus `groups` |
| `SpendGroupBy` | `"provider" \| "model" \| "day"` |
| `InvalidSpendEntryError` | thrown by `summarizeSpend` for an entry whose cached tokens exceed its prompt tokens |
| `summarizeSpend(entries, by)` | aggregates; groups sorted by cost descending, ties by key ascending; `perMillionOutput` is `0` when output is `0`; `cacheShare` is `0` when prompt is `0`; `day` is the UTC date of `at` |

Tests: `packages/core/tests/unit/spend-summary.test.ts`.

## 2. Inbound port — `packages/core/src/ports/inbound/spend.ts`

Serves uc-1…uc-5; depends on the domain only.

| name | responsibility |
|---|---|
| `SpendQuery` | `day?` (ISO date), `since?`, `until?` (epoch ms), `by` |
| `SpendReport` | `window`, `coverage` (`complete`/`partial`), `covered`, `summary`, `malformed` lines skipped |
| `SpendReportPort.report(query)` | the report for one window |

## 3. Outbound port — `packages/core/src/ports/outbound/spend-log.ts`

Serves uc-1…uc-3. Abstracts the exchange log so the application never touches the filesystem.

| name | responsibility |
|---|---|
| `SpendLogRead` | `entries`, `malformed`, `covered` (`undefined` when nothing was read) |
| `SpendLogPort.read(window)` | the entries of the exchanges inside the window |

## 4. Application — `apps/proxy/src/application/spend-report-service.ts`

`SpendReportService extends SpendReportPort`. Injected: `SpendLogPort`, a clock (`() => number`).

- resolves `day` to local midnight-to-midnight, `since`/`until` as given, default window is today;
- marks the report `partial` when `covered.from > window.from`;
- delegates the arithmetic to `summarizeSpend`.

Tests: `apps/proxy/tests/component/spend-report-service.test.ts`.

## 5. Adapter — `apps/proxy/src/adapters/outbound/spend-log-reader.ts`

`SpendLogReader extends SpendLogPort`. Injected: the logs directory.

- selects files with the existing `LOG_FILE` regex and `USAGE_LOG` kind
  (`apps/proxy/src/adapters/outbound/log-files.ts`), from the date in the file name;
- streams each line, counts an unparsable line as `malformed`, never throws for one;
- keeps `client-response` records with `status === 200` and `usage.raw`;
- reads `model` and `provider` from the first SSE `data:` chunk of the response body (the same shape the
  2026-11-06 measurement parsed), `provider` falling back to `unknown`;
- `covered` is the span of the files it read, not of the entries it found.

Tests: `apps/proxy/tests/component/spend-log-reader.test.ts`, fixtures in
`apps/proxy/tests/fixtures/spend/`.

## 6. Inbound adapter — `apps/proxy/src/adapters/inbound/cli/commands/cost-command.ts`

`CostCommand extends CliCommand`, `COST_HELP` in the shape of `TOKEN_HELP`.

- parsing: `--day`, `--since`, `--until`, `--by`, `--json`, `--reconcile`, `--watch`, `--budget-daily`,
  `--budget-monthly`; an unknown flag or a malformed value is a `UsageError`;
- rendering: human table or `JSON.stringify(report, null, 2)`;
- watch: loop with an injected sleep, one status line per tick, exit `4` on the first breach,
  `notify-send` when the binary is present;
- reconcile: `Bun.spawn(["opencode", "stats", "--days", n, "--cost", "--json"])` with a 20 s cap; a
  missing binary or a timeout prints `reconciliation skipped` and keeps exit `0`.

Registered in `apps/proxy/src/composition/container.ts` (`proxyCommands`, after `QuotaCommand`) and in
`PROXY_HELP.subcommands` (`proxy-commands.ts`).

Tests: `apps/proxy/tests/e2e/cost.test.ts`, `apps/proxy/tests/component/cost-watch.test.ts`,
`apps/proxy/tests/live/cost-reconcile.test.ts`.
