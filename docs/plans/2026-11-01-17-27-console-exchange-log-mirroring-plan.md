# Plan 2026-11-01-17-27 — Mirror redacted exchange records to `serve` stdout and enforce bounded log retention

## 1. Request, scope and decision

The operator reported that the foreground `bun run proxy serve` terminal did not show usage/exchange records and additionally asked:
> *"Can we additionally make logs accumulated to never pass the 500 MBs? Can we make that part of the config? Can we proceed?"*

This plan unites both operational requirements:
1. **Exchange console mirroring:** Mirror already-redacted exchange JSON lines to stdout while `serve` runs.
2. **Total log directory retention cap:** Add `logs.maxTotalMegabytes` (default `500`, configurable in `proxy.yaml`) to `LockedLogRetention`, enforcing that accumulated log files in the proxy log directory never exceed the configured cap.

| Item | Current measured behaviour | Required behaviour |
|---|---|---|
| `serve` stdout | Daemon log lines only | Daemon log lines **and** every already-redacted exchange JSON line |
| Usage files | One JSON line per exchange record | Unchanged; stdout is an additional best-effort destination |
| Other proxy commands | No daemon console mirror | Unchanged |
| Total logs size | Unbounded (accumulated 13.8 GB across 155 files) | Strictly bounded to `maxTotalMegabytes` (default `500` MB, configurable) |
| Log retention, rotation, files and permissions | Time-only pruning (15 days); 100 MB per-file rotation | Pruned by time (15 days) **and** by total size (500 MB max) from oldest to newest |

This is an amendment to the terminal decision recorded in `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/plans/2026-10-27-23-29-locked-writes-and-log-files-plan.md` §1 U4 and §2 L5. That dated record remains historical evidence; this plan supersedes its terminal-output rule and augments its retention rule.

Out of scope: changing what is captured, adding request filtering, changing redaction rules, changing provider request behaviour, changing non-`serve` command output, or touching the already-running operator daemon PID `2475341`.

## 2. Evidence baseline (measured 2026-11-01)

| Evidence | Observed fact | Consequence |
|---|---|---|
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/exchange-log-file.ts:32-37` | `StreamExchangeSink.write()` serializes a redacted entry and sends it only to `LogStreamPort`. | Usage records have no console destination. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/console-mirror.ts:1-3` | `TerminalMirror` receives only ordinary daemon log lines; its source comment says usage records go only to files. | The missing terminal records are intentional current code, not a terminal failure. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/composition/container.ts:425-439` | The graph creates both `TerminalMirror` and `StreamExchangeSink`, but supplies the mirror only to `MirroredLogger`. | Composition has the needed two destinations but does not connect them. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/core/src/domain/config.ts:30-34` | `LogSettings` defines only `{ usage, retentionDays, maxFileMegabytes }`. `DEFAULT_LOGS` has no total size cap. | Total log accumulation is unbounded by size, constrained only by day count. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/log-files.ts:114-147` | `LockedLogRetention.removeOld()` deletes files only if `day < oldestKept`. | Rotation can produce dozens of 100 MB files per day without total size bounding. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/logs/` inventory at 2026-11-01T17:27:15-06:00 | 155 files, 14,479,804,675 bytes (~13.8 GB); latest process usage files exist. | File logging is functioning; log accumulation demonstrates the urgent need for a 500 MB total directory cap. |

## 3. Required invariants

1. The same **single, already-redacted JSON string** is fanned out to the usage file and to stdout. Redaction must happen before either destination, exactly once per entry. Neither a credential value nor a token/key field may appear in either destination.
2. `serve` emits one newline-terminated stdout line per `ExchangeEntry` emitted by the daemon after `DaemonConsoleService.attach()`; it includes all existing kinds: `client-request`, `client-response`, `upstream-request`, `upstream-response`, `login-callback`, and `browser-open` when those flows occur.
3. `logs.usage: false` creates no exchange sink and therefore emits no exchange JSON lines to stdout. Daemon log lines remain unchanged.
4. The mirror stays silent before attach and in commands other than `serve`; `help`, `token`, `status`, `models`, `login`, and other commands retain machine-readable stdout contracts.
5. A failing file append or terminal write remains best effort: it cannot change a request/response result, crash the daemon, leak an unredacted value, or prevent the other destination from being attempted.
6. Existing log-file behaviour is preserved: per-process files, UTC-day and size rotation, 0600 files, 0700 directory, locked retention sweep, normal-shutdown flush, and no shared log-file writer.
7. A request that never arrives at the proxy has no client or upstream exchange record in either destination; this change cannot log upstream client/scheduler failures outside the proxy process.

## 4. Implementation graph

### 4.1 Ports and adapters

| Layer | Absolute path | Change |
|---|---|---|
| Domain | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/packages/core/src/domain/config.ts` | Add `maxTotalMegabytes` to `LogSettings` (default `500`, validated positive integer in `logs.maxTotalMegabytes`). |
| Outbound adapter | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/log-files.ts` | Add `maxTotalMegabytes` to `LockedLogRetention`. Add `stat` to `RetentionFs`. In `sweep()`, after time-based pruning, compute total directory size; if exceeding cap, prune oldest log files until within cap. |
| Outbound adapter | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/exchange-log-file.ts` | Extend `StreamExchangeSink` with the existing abstract `ConsoleMirrorPort`. Build the redacted `exchangeLine` once, then independently send that exact string to the usage `LogStreamPort` and console mirror. Keep both calls separately best effort. |
| Outbound adapter | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/outbound/console-mirror.ts` | Change the source-level contract comment from “usage records go only to the usage files” to the final two-destination rule; retain attach gating and newline handling. |
| Composition root | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/composition/container.ts` | Inject `mirror` into `StreamExchangeSink`, and pass `config.logs.maxTotalMegabytes` to `LockedLogRetention`. |
| CLI adapter | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/src/adapters/inbound/cli/commands/daemon-commands.ts` | Make `serve --help` describe both stdout destinations, state that records obey `logs.usage`, and remove obsolete `exchangeLog.enabled` wording. |

The implementation remains hexagonal: `StreamExchangeSink` depends on the outbound `ConsoleMirrorPort` abstraction and `LogStreamPort` abstraction; the concrete terminal and Winston streams are wired only in the composition root.

### 4.2 Ordering and failure semantics

For each entry, `StreamExchangeSink` must first compute the redacted line. It then attempts the file and console writes independently. The canonical equality check is the parsed JSON record, including field values and record order after normal daemon shutdown flush; it does not depend on OS-level interleaving between separate file descriptors. The console line uses the existing `TerminalMirror.line()` newline boundary.

No retry queue, cross-process stdout lock, or second file is added. Each daemon process already has one terminal and its own per-PID usage files; requests remain asynchronous and logging remains non-blocking/best effort by contract.

## 5. Test plan and coverage obligations

| Test tier | Absolute path | New or changed proof | Failure modes covered |
|---|---|---|---|
| Unit | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/unit/console-mirror.test.ts` | Replace the obsolete assertion that usage records never reach stdout with tests for attach gating and newline-exact mirrored JSON. Preserve tests for ignored console `EPIPE`. | before-attach silence; one-line boundary; console failure |
| Component | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/component/exchange-log-file.test.ts` | Supply separate fake file and console ports; prove their parsed records are identical, redacted, timestamped and PID-tagged. Add one test per destination throwing while the other still receives the redacted line. | exact fan-out; header/body redaction; file failure; console failure; no throw to caller |
| Component | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/component/container.test.ts` | Assert graph wiring injects the console mirror into the exchange sink and that the enabled/disabled `logs.usage` graph branches keep their existing semantics. | composition omission; `logs.usage: false` |
| Unit/CLI | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/unit/cli-commands.test.ts` | Update the `serve` help snapshot/assertions so it names `logs.usage`, not `exchangeLog`, and accurately describes redacted exchange JSON stdout. | stale help contract |
| E2E | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/e2e/daemon.test.ts` | Replace zero-JSON-lines assertion with a real hermetic daemon proof: parse JSON stdout lines after a replayed request and compare the daemon PID’s ordered records to `/logs/<day>-<pid>-usage.jsonl`; assert all four request kinds, schema, and absence of the proxy token in both outputs. Add a `logs: {usage: false}` daemon case that proves no JSON stdout records and no usage file. | real process wiring; request/response coverage; exact redacted file/terminal parity; token non-disclosure; disabled logging |
| Documentation contract | `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/unit/docs-in-step.test.ts` and `/home/mavasbel/Dev/repos/devtools/accounts-proxy/apps/proxy/tests/e2e/docs.test.ts` | Extend assertions where appropriate so the public command/help and API-reference statement cannot regress back to file-only or obsolete configuration terminology. | code/documentation drift |

All new executable branches must be covered by the measured unit/component, e2e, and merged Istanbul gates. No deferred-coverage entry is permitted.

## 6. Documentation changes

| Absolute path | Required update |
|---|---|
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/README.md` | State that foreground `serve` mirrors ordinary daemon lines and redacted exchange JSONL to stdout; explain that `logs.usage: false` disables exchange records only. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/reference/2026-10-17-19-26-proxy-api.md` | Amend `logs.usage` and data-directory documentation to state both file persistence and the `serve` stdout copy, including redaction and the no-proxy-arrival boundary. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/reference/2026-10-17-19-26-client-setup.md` | Add a concise operator-observability note showing that a foreground daemon prints redacted JSON records and that the JSONL files are the durable audit trail. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/architecture.drawio` | Update the request-flow/logging destination only if its current diagram says or implies file-only exchange logging; preserve the current model otherwise. |
| `/home/mavasbel/Dev/repos/devtools/accounts-proxy/docs/plans/2026-11-01-17-27-console-exchange-log-mirroring-plan.md` | Append measured implementation, test, release-gate and live-observation results after execution; do not rewrite the evidence baseline. |

Historical plan documents remain unchanged because they record the decision in force at that time.

## 7. Execution order

1. Re-read the listed source and tests immediately before editing; record the working-tree status and confirm no unrelated user changes are overwritten.
2. Write the failing component and e2e assertions first, including both-destination equality and token-redaction tests.
3. Implement the single-redaction/two-destination adapter change and composition injection.
4. Correct command help and source-contract comments.
5. Run targeted typecheck and the changed unit/component/e2e files; correct every failure without weakening assertions.
6. Update all listed documentation and documentation-contract tests. Regenerate no unrelated artifacts.
7. Run the complete release gate: `bun run verify`. It must end `GATE: PASS`, with exactly 100% statements, branches, functions and lines in unit/component, e2e and merged reports, plus architecture, recon parity and docs lint passes.
8. Run an isolated live-process observation using a temporary `ACCOUNTS_PROXY_HOME`, all hermetic upstream seams, and a replayed request. Capture stdout and its usage file, parse both, demonstrate exact record equality and zero token occurrences. This does not use live provider credentials or alter `/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/`.
9. Do not stop or restart the operator-run daemon at `127.0.0.1:4141`. After the implementation has passed the hermetic gate, provide the operator one explicit foreground restart command and a safe inspection command for voluntary manual verification.
10. Audit the final staged diff for credentials, account identifiers and generated runtime data before any commit. Commit only the scoped source, tests and documentation after the audit and final gate results are recorded.

## 8. Measurable acceptance criteria

| ID | Criterion | Required evidence |
|---|---|---|
| A1 | A replayed inference through a `serve` process produces four matching JSON records on stdout and in its usage JSONL file. | Parsed ordered record arrays, same schema, IDs, redacted values and daemon PID. |
| A2 | Every stdout exchange record is already redacted and the actual proxy token is absent from stdout and usage files. | Explicit negative assertions using the test daemon token and secret header/body fixtures. |
| A3 | `logs.usage: false` produces neither usage JSONL records nor stdout exchange JSON records. | Hermetic e2e daemon result. |
| A4 | `serve --help` accurately describes the final behavior and contains no `exchangeLog.enabled` wording. | Unit CLI assertion and actual CLI output. |
| A5 | A file-write or terminal-write failure cannot fail the proxied operation and cannot make the other destination receive unredacted content. | Component failure-isolation tests. |
| A6 | Existing rotation, retention and graceful shutdown behaviour remains green. | Existing log-file component/e2e tests plus complete `bun run verify`. |
| A7 | No unrelated live state changes. | Before/after hash inventory of `/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/` excluding append-only test-external logs; hermetic test homes only. |
| A8 | Release quality. | Complete `bun run verify` exit 0 and a secret/identity scan of the staged diff with zero findings. |

## 9. Risks and controls

| Risk | Control |
|---|---|
| Console output contains credentials | Fan out only the already-redacted serialized line; assert the real test token and fixture secrets are absent in both destinations. |
| Machine-readable output of other commands changes | Do not attach the terminal mirror outside `serve`; e2e/CLI tests retain their current contracts. |
| A console failure disrupts inference | Independently catch the console write, exactly as file logging is best effort. |
| File and console records diverge | Serialize once; compare parsed complete record sequences after graceful shutdown. |
| Concurrent processes corrupt a shared usage file | Preserve per-PID files and do not introduce shared-stream writes. |
| Live daemon disruption | Use only temporary hermetic homes during verification; require operator action for any later manual restart. |

## 10. Approval boundary

This document is a plan and contains no source, configuration, process, credential, or runtime-data change. Implementation begins only after approval of this plan.
