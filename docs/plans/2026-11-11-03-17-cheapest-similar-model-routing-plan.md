# Cheapest similar-performance model routing

- **Plan:** `docs/plans/2026-11-11-03-17-cheapest-similar-model-routing-plan.md`
- **Session:** `docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`
- **Status:** draft, awaiting approval. Nothing in this plan is executed before approval.
- **Timestamps:** every dated document this plan creates carries the timestamp `2026-11-11-03-17`, read from the system
  with `date +%Y-%m-%d-%H-%M` on 2026-11-11 at 03:17 (rule §8.2). Build does not re-derive it.
- **Placeholders defined here:** `{repo}` = `/home/mavasbel/Dev/repos/devtools/accounts-proxy`; `{worktree}` =
  `{repo}/worktrees/feat-cheapest-routing`; `{home}` = `{repo}/.cache` (the proxy's data directory).

## 1. Why

Today one request names one model and the proxy forwards it to that model's provider, with no alternative ever
considered: `PassthroughService.forward` resolves the address and calls that provider
(`{repo}/apps/proxy/src/application/passthrough-service.ts:20-29`). The proxy already holds, for every listed model, its
price per million tokens (`ModelDetails.cost`, base entry plus optional context tiers,
`{repo}/packages/core/src/domain/model-details.ts:16-23`, `:49`) and its factual capabilities (`toolCall`, `input`
modalities, `contextWindow`, `maxOutputTokens`, `:35-45`). It holds **no** notion of model quality: a grep of every
production `.ts` under `packages/*/src` and `apps/proxy/src` for `score`, `rank`, `quality` and `benchmark` returns zero
identifiers, types or logic — the only matches are prose inside model `description` strings.

That gap has a measured price. From the daemon's own live catalog on 2026-11-10 (`GET /proxy/v1/models`, all seven
providers `source: live`) joined to the BenchLM BenchAlign composite (214 ranked models of 1020 tracked, last verified
2026-11-10):

| Model | in / out $ per 1M | composite | in-price ratio |
|---|---|---|---|
| `inclusionai/ling-3.1-flash` | 0.045 / 0.135 | 65.26 | 1× |
| `deepseek/deepseek-v4.1-flash` | 0.051 / 0.567 | 65.13 | 1.1× |
| `anthropic/claude-haiku-5.5` | 0.10 / 0.50 | 66.17 | 2.2× |
| `meta/muse-ember` | 0.10 / 0.50 | 56.29 | 2.2× |
| `openai/gpt-6-luna` | 0.10 / 0.50 | 62.37 | 2.2× |
| `muse-spark-1.2` (`opencode`) | 1.25 / 4.25 | 65.35 | 27.8× |
| `anthropic/claude-opus-5.5` | 2 / 10 | 85.77 | 44× |

Two models **0.09 composite points apart** (`muse-spark-1.2` 65.35, `ling-3.1-flash` 65.26) differ **27.8×** in input
price. A client that names the dearer one pays that multiple for no measured capability: that is the waste this feature
removes. The proxy cannot fix it today because it has no way to say "these two are equivalent" and no way to pick the
cheaper of them.

## 2. What

- **W1.** A new `routing:` block in `{home}/proxy.yaml` (strictly parsed like every other key, default **off**):
  `enabled`, `tolerancePoints`, `inputOutputRatio`, `withholdFrom`, `includeSubscription`, `moveOffSubscription`,
  `quality`.
- **W2.** A committed, provenance-carrying quality table: `packages/core/src/domain/model-quality.ts`, generated from two
  committed inputs (a BenchLM leaderboard extract and a catalog snapshot) by
  `scripts/evidence/derive-quality.ts`, each entry `{ score, source, date }`. No score exists without a URL and a date.
- **W3.** A pure routing rule in `packages/core/src/domain/model-routing.ts`: given the requested model, the request's
  shape, the candidate models and the policy, it returns the cheapest similar model or an explicit reason why not.
- **W4.** The decision applied on the passthrough path only: a request routed to another model forwards that model's own
  body to that model's own provider cell, unchanged (no translation, unchanged law §2/D1-A).
- **W5.** Observability: response headers `x-proxy-routed-from`, `x-proxy-routed-to`, `x-proxy-route-reason`,
  `x-proxy-route-price`, and a `route-decision` record in the usage log, so every decision is auditable after the fact.
- **W6.** A per-request override header `x-proxy-route: cheapest|requested` (default from the config).
- **W7.** A never-fail property: any doubt (unknown quality, no price, capability mismatch, stale catalog, malformed
  body) forwards the requested model unchanged and records the reason. Routing never turns a working request into an
  error.
- **W8.** Tests at all four tiers, 100 % line/statement/function/branch coverage of every new file, a negative scenario
  for every use case in every tier that covers it.
- **W9.** The design pair (`docs/design/`), the quality rules and the generated quality reference in `docs/reference/`.
- **W10.** Every existing document in step: API reference §3/§4/§7/§8, OpenAPI 3.1, providers reference, architecture
  diagram (Request flow page), README §configuration, `AGENTS.md` §2 (the new law) and §7 (the reference document).

## 3. Out of scope

- **No translation** between wire formats (P5 cancelled, decision D1-A, unchanged).
- **No benchmark run of our own**: scores are curated from a committed third-party extract; the proxy never measures.
- **No derivation of quality from price, context size, family or name** — that would be a guess, forbidden by §1.8.
- **No mid-request re-routing** (a stream is never moved after the first byte).
- **No budget or quota enforcement** (the spend report owns that); routing ignores spend limits.
- **No changes** to credentials, sessions, renewal, accounts, or provider cells.
- **No new HTTP route and no new CLI command.**
- **No automatic refresh of the quality table** from the network at run time; it changes only by a committed edit.

## 4. Decisions (fixed here; each names the rejected alternative)

- **D1 — Where quality comes from:** a committed table generated from a committed extract, with the raw extract kept as
  evidence. *Rejected:* fetching a benchmark API per decision (a third-party runtime dependency, a new failure mode per
  request, and an unauditable number); deriving a rank from price or context (a guess).
- **D2 — What "similar" means:** `quality ≥ requestedQuality − tolerancePoints`, with no upper bound, so a better model
  is allowed only when it is also cheaper. Default `tolerancePoints: 3`. *Rejected:* fixed tiers/bands (a second taxonomy
  to maintain); percentile bands (unstable when the table grows).
- **D3 — Subscription cells:** excluded as candidates unless `includeSubscription: true`, because their `cost` is absent
  by law (rule M5, `model-details.ts:169`) and their use is metered by plan quota, not by dollars. With the flag on, their
  marginal price is `0`. *Rejected:* always including them (every request would route to Claude, and the plan quota would
  be spent invisibly).
- **D4 — Unpriced gateways:** a model without a `cost` is never a candidate (that includes every `cheaper-inference`
  model, whose lists state no price). *Rejected:* treating an absent price as 0 (a false claim).
- **D5 — Unknown quality:** a candidate whose score is unknown is never chosen; the requested model with an unknown
  score is forwarded unchanged with reason `unknown-quality`. The table grows by regeneration or by the `routing.quality`
  override. *Rejected:* treating unknown as a median score (a guess).
- **D6 — Capability gates:** a candidate must accept the request's format natively, must have `toolCall === true` when the
  body carries tools, must declare `image` in `input` when the body carries an image, and must satisfy the request's
  output/context limits **when those limits are known**. An unknown numeric limit does not disqualify (an upstream
  refuses it cleanly); an unknown tool capability does (a silent tool-call failure inside an agent loop is not
  recoverable). *Rejected:* body rewriting to fit a cheaper model (that is translation by another name).
- **D7 — Price used for ranking:** `cost[0]` (the base tier) as `input × inputOutputRatio + output`, per million tokens,
  default ratio 10. Context tiers exist but the request's prompt size is not known exactly without tokenising, so the
  base tier is used and the limitation is stated in the reference; `x-proxy-route-price` names the basis. *Rejected:*
  estimating tokens from body bytes (a guess); calling `count_tokens` per decision (a paid round-trip per request).
- **D8 — Determinism:** the pure selection has no clock, no randomness and a total tie-break order
  (`price` asc → `quality` desc → `PROVIDER_IDS` index → model id asc). The same inputs always give the same answer.
- **D9 — Never fail:** every fallback forwards the requested model. Routing cannot produce a 4xx/5xx of its own.
- **D10 — Where the decision runs:** `PassthroughService` calls a new `ModelRoutingPort` **before** `provider.nativeFormats`
  and **after** the address is resolved — an alias resolves to a concrete `<provider>/<model>` first, so routing applies
  to what the alias names. The existing format and disabled-provider errors keep their order and shape. *Rejected:*
  routing inside `RouteHandler` (the inbound adapter would own a policy); routing before alias resolution (two
  resolvers disagreeing).
- **D11 — A request that is already paid for is never moved:** a request whose own model carries no price is never
  rerouted. That covers the three subscription cells (a flat-fee plan already bought, so a dollar-cheaper gateway model is
  not cheaper in fact) and every `cheaper-inference` model (no price stated, so no comparison is possible). Reason
  `subscription-flat-fee` or `unpriced-requested` respectively. The one exception is explicit:
  `routing.moveOffSubscription: true`, which lets a subscription request be answered by the cheapest qualifying gateway
  model — the requested model is then simply not in the candidate set. *Rejected:* rerouting a paid-plan request by
  default (it would spend plan quota on models the user already paid for and then charge a gateway on top); treating an
  absent price as 0 for the *requested* model (it would make every request "infinitely cheaper" elsewhere).

## 5. Use cases, scenarios and where each is proved

Scenario tags: `feature=routing use-case=uc-N dependency=none|gateways|reference-catalog`.

| Use case | Scenarios | unit | component | live | e2e |
|---|---|---|---|---|---|
| **uc-1** route to the cheapest similar model | happy path picks the cheapest priced model within the band | `model-routing.test.ts` | `model-routing-service.test.ts` | `routing-catalogs.test.ts` | `routing.test.ts` |
| **uc-2** fall back to the requested model | no candidate within band / unpriced / unknown quality | `model-routing.test.ts` | `model-routing-service.test.ts` | — | `routing.test.ts` |
| **uc-3** never cross a capability boundary | tools, image, output limit, native format | `model-routing.test.ts` | `model-routing-service.test.ts` | — | `routing.test.ts` |
| **uc-4** per-request override | `x-proxy-route: requested` forwards as asked | — | `route-headers.test.ts` | — | `routing.test.ts` |
| **uc-5** observe the decision | headers and `route-decision` record | — | `route-headers.test.ts` | — | `routing.test.ts` |
| **uc-6** admin control | `withholdFrom`, `routing.quality` override, `includeSubscription`, `moveOffSubscription` | `config-and-oauth.test.ts` | `model-routing-service.test.ts` | — | `routing.test.ts` |
| **uc-7** stale or inconsistent catalog | catalog says a format the provider refuses → fall back | `model-routing.test.ts` | `model-routing-service.test.ts` | — | `routing.test.ts` |

**Negative scenario per use case, per tier that covers it** (§6.6): uc-1 a candidate that is cheaper but 0.1 below the
band is not chosen; uc-2 an empty candidate set forwards the request and answers 200; uc-3 a tools request never reaches a
model with `toolCall` unset; uc-4 no routing record is written for an overridden request; uc-5 no header when routing is
off; uc-6 a withheld provider is never chosen even when cheapest; uc-7 a stale catalog still answers the client 200.

## 6. Closed inventory

**Created (20 files).** `{repo}/packages/core/src/domain/model-quality.ts`,
`{repo}/packages/core/src/domain/model-routing.ts`, `{repo}/packages/core/src/domain/services/request-shape.ts`,
`{repo}/packages/core/src/ports/outbound/model-routing.ts`,
`{repo}/apps/proxy/src/application/model-routing-service.ts`, `{repo}/scripts/evidence/derive-quality.ts`,
`{repo}/docs/reference/specs/benchlm-leaderboard-2026-11-11.json`,
`{repo}/docs/reference/specs/catalog-snapshot-2026-11-11.json`,
`{repo}/docs/reference/2026-11-11-03-17-model-quality-scores.md`,
`{repo}/docs/reference/2026-11-11-03-17-model-quality-rules.md`,
`{repo}/docs/design/2026-11-11-03-17-cheapest-routing-product.md`,
`{repo}/docs/design/2026-11-11-03-17-cheapest-routing-architecture.md`,
`{repo}/packages/core/tests/unit/model-routing.test.ts`, `{repo}/packages/core/tests/unit/model-quality.test.ts`,
`{repo}/packages/core/tests/unit/request-shape.test.ts`,
`{repo}/apps/proxy/tests/component/model-routing-service.test.ts`, `{repo}/apps/proxy/tests/component/quality-extract.test.ts`,
`{repo}/apps/proxy/tests/component/route-headers.test.ts`, `{repo}/apps/proxy/tests/e2e/routing.test.ts`,
`{repo}/apps/proxy/tests/live/routing-catalogs.test.ts`.

**Edited (14 files).** `{repo}/packages/core/src/domain/config.ts`, `{repo}/packages/core/src/domain/exchange-log.ts`,
`{repo}/apps/proxy/src/application/passthrough-service.ts`, `{repo}/apps/proxy/src/composition/container.ts`,
`{repo}/apps/proxy/src/adapters/inbound/http/route-handler.ts`, `{repo}/config/proxy.example.yaml`,
`{repo}/docs/reference/2026-10-17-19-26-proxy-api.md`, `{repo}/docs/reference/2026-10-17-19-26-proxy-openapi.json`,
`{repo}/docs/reference/2026-10-17-19-26-providers.md`, `{repo}/docs/architecture.drawio`, `{repo}/README.md`,
`{repo}/AGENTS.md`, `{repo}/apps/proxy/tests/unit/docs-in-step.test.ts`,
`{repo}/packages/core/tests/unit/config-and-oauth.test.ts`.

**Deleted.** nothing.

## 7. Delegation map

| Stage | Runs in | Why |
|---|---|---|
| 0 | main session | worktree and baseline are the release's own bookkeeping (§4.1) |
| A | subagent `general` | evidence fetch, extract and generator; mechanical |
| B | subagent `general` | two design documents drafted from §1–§6 of this plan |
| C | subagent `general` | domain code and its unit tests |
| D | subagent `general` | port, application service, composition wiring |
| E | subagent `general` | documents in step |
| F | subagent `general` | component/live/e2e tests |
| G | main session | the final gate and the release decision (§4.7) |

## 8. Stages

### Stage 0 — Isolate and record the baseline

**Why.** AGENTS.md §7 forbids work on the default branch, and §3.8 requires the gate's state on the unchanged tree before
the first change, so a later failure is never mistaken for a regression.

**What.** `{worktree}` on branch `feat-cheapest-routing`, dependencies installed into it, and the unchanged gate's output
recorded.

- **S0.1** — *runs in:* main session · *action:* run · *target:* `{repo}` · *content:*
  `git -C /home/mavasbel/Dev/repos/devtools/accounts-proxy fetch && git -C /home/mavasbel/Dev/repos/devtools/accounts-proxy worktree add -b feat-cheapest-routing /home/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-cheapest-routing main`
  · *depends on:* none · *gates:* (1) `git -C {repo} worktree list` lists `{worktree}` with branch
  `feat-cheapest-routing`; (2) `test -f {worktree}/bun.lock` exits 0 · *problems:* branch already exists → remove it with
  `git -C {repo} branch -D feat-cheapest-routing` after `worktree remove`; `worktrees/` already ignored at
  `{repo}/.gitignore:15` · *escalation:* ask the user whether the leftover branch is theirs before deleting it ·
  *failure:* no worktree, no work; undo with `git -C {repo} worktree remove {worktree}` · *returns:* the worktree path.
- **S0.2** — *runs in:* main session · *action:* run · *target:* `{worktree}` · *content:*
  `cd /home/mavasbel/Dev/repos/devtools/accounts-proxy/worktrees/feat-cheapest-routing && bun install --frozen-lockfile`
  · *depends on:* S0.1 · *gates:* (1) exit 0; (2) `git -C {worktree} status --porcelain` prints nothing; (3)
  `bun --version` prints `1.4.2` · *problems:* lockfile drift fails the frozen install — that is evidence of drift, never a
  reason to drop the flag · *escalation:* report the lockfile difference and stop · *failure:* uninstalled environment;
  rerun · *returns:* the installed versions.
- **S0.3** — *runs in:* main session · *action:* run · *target:* `{worktree}` · *content:* `bun run verify` in
  `{worktree}`, output captured to `/tmp/opencode/baseline-verify.log` · *depends on:* S0.2 · *gates:* (1) the log's last
  line reports the gate's verdict and exit code; (2) every coverage tier prints `100%`; (3) `docs lint` passes
  · *problems:* a pre-existing failure → record it as pre-existing with its output and continue (never repair it
  silently); a machine-load timeout → rerun once, then record the load evidence (`uptime`); a parity step that needs
  untracked state the worktree lacks → run the same command in `{repo}` and record both outputs, naming the worktree's
  missing state as the cause, never as a pass · *escalation:* a pre-existing failure in a file this plan touches stops the
  plan until the user decides · *failure:* no baseline; the plan cannot distinguish a regression · *returns:* the baseline
  log path and its exit code.

**Stage gate.** `{worktree}` exists on its branch, `git -C {worktree} status --porcelain` is empty, and the baseline log
records the gate's verdict with its coverage figures.

### Stage A — Quality ground truth

**Why.** The feature cannot exist without a defensible number per model, and §1.6 forbids any number without evidence. The
extract and the snapshot are the only two inputs, both committed, so every score is reproducible.

**What.** A committed extract, a committed catalog snapshot, a generator that emits the table and its reference from
them, and the rules document that defines what a score means.

- **S1.1** — *runs in:* subagent · *action:* run · *target:*
  `{repo}/docs/reference/specs/benchlm-leaderboard-2026-11-11.json` · *content:*
  `curl -sSL -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' https://benchlm.ai/leaderboard -o /tmp/opencode/benchlm.html`
  then extract the `__NEXT_DATA__` leaderboard rows (id, model, slug, provider, inputPrice, outputPrice, score) into the
  target · *depends on:* S0.3 · *gates:* (1) the file parses as JSON; (2) it holds 1020 rows of which 214 carry a numeric
  score; (3) `lastUpdated` equals `November 10, 2026` · *problems:* a changed page shape → the extraction fails loudly, never
  a partial file; a newer leaderboard → record the date in the file and in the rules document · *escalation:* ask the user
  whether to pin the 2026-11-10 snapshot or take the newer one · *failure:* no evidence for §1.6; undo by deleting the file
  · *returns:* row count, scored count, snapshot date.
- **S1.2** — *runs in:* subagent · *action:* run · *target:*
  `{repo}/docs/reference/specs/catalog-snapshot-2026-11-11.json` · *content:* the daemon's own detailed catalog:
  `TOKEN=$(python3 -c 'import json;print(json.load(open("/home/mavasbel/Dev/repos/devtools/accounts-proxy/.cache/token.json"))["token"])'); curl -sS -D /tmp/opencode/models-headers.txt -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4141/proxy/v1/models`
  written to the target with a leading `_provenance` object stating the URL, the UTC time and the daemon's `x-proxy-models-source`
  header · *depends on:* S0.3 · *gates:* (1) it parses; (2) it holds one catalog per enabled provider (seven today); (3)
  every model entry has `id`, `provider`, `model`, `formats`; (4) the token is never printed — the command is the only
  place it is used · *problems:* the daemon is not listening → start it in another terminal with
  `bun run proxy serve` and rerun; a provider in `unavailable` state → the snapshot records it and Stage A continues
  (candidacy there is later proven live) · *escalation:* ask the user to start the daemon · *failure:* the join has no
  candidate universe; undo by deleting the file · *returns:* catalog count, model count, any unavailable provider.
- **S1.3** — *runs in:* subagent · *action:* create · *target:* `{repo}/scripts/evidence/derive-quality.ts` · *content:*
  a Bun script with two modes: no argument writes, `--check` verifies without writing. It reads the two inputs of S1.1 and
  S1.2, normalises ids (`lowercase`, strip a leading `~`, strip a `:free|:batch` suffix, take the segment after the last
  `/`, drop every non-alphanumeric character), joins snapshot model → extract row, and emits **exactly two files**: the
  table `packages/core/src/domain/model-quality.ts` and the reference
  `docs/reference/2026-11-11-03-17-model-quality-scores.md`. The table's shape is fixed: `export const QUALITY_SCORES:
  Readonly<Record<string, QualityEntry>>` keyed by **bare model id**, value `{ score: number; source: string; date: string }`
  where `source` is `https://benchlm.ai/models/<slug>` and `date` is `2026-11-10`; the file's header states that it is
  generated and names its generator. The markdown is one table row per score: `| model id | score | source | date |`, with a
  header naming the snapshot, the row count and the coverage (`models with a score / models in the snapshot`) · *depends
  on:* S1.1, S1.2 · *gates:* (1) `bun scripts/evidence/derive-quality.ts --check` exits 0 on a fresh generation; (2) the
  script writes nothing outside those two paths (`git -C {worktree} status --porcelain` names only them); (3) the emitted
  table has no entry whose `source` is not `https://` · *problems:* two snapshot models normalise to one key with different
  scores → the script fails naming both, never picks one silently; a model in the snapshot absent from the extract → it is
  omitted and counted in the coverage line · *escalation:* a collision the user must choose between → ask which id is
  canonical · *failure:* no table; undo by deleting the script and both outputs · *returns:* entry count, coverage ratio.
- **S1.4** — *runs in:* subagent · *action:* run · *target:* `{worktree}` · *content:*
  `cd {worktree} && bun scripts/evidence/derive-quality.ts` · *depends on:* S1.3 · *gates:* (1) both files exist; (2)
  `bun -e "import {QUALITY_SCORES} from './packages/core/src/domain/model-quality.ts'; console.log(Object.keys(QUALITY_SCORES).length)"`
  prints a number ≥ 100; (3) `--check` exits 0 immediately after · *problems:* fewer than 100 scored models → the join is
  broken; inspect the normalisation against three known models before proceeding · *escalation:* report the count and the
  three inspected ids · *failure:* the table is unusable; undo by deleting both outputs · *returns:* the count.
- **S1.5** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/docs/reference/2026-11-11-03-17-model-quality-rules.md` · *content:* rules Q1–Q8, each one paragraph: Q1 what a
  score is (the BenchLM BenchAlign v5 composite, 0–100, 214 ranked of 1020 tracked); Q2 its provenance (the URL, the
  snapshot date, the extract path) and that 135 of the 214 ranks are `estimated` rather than `supported`; Q3 how ids join
  (the normalisation of S1.3, with three worked examples); Q4 unknown score semantics (not a candidate — never a guess);
  Q5 the `routing.quality` override precedence (override wins, and an override has no source, which is stated); Q6 what a
  score is *not* (not a benchmark we ran, not a capability claim, not comparable across a benchmark variant); Q7 the
  staleness rule (a table older than 180 days is reported by `models --refresh`'s summary — recorded, not enforced);
  Q8 the coverage line (scored models / snapshot models, reported by the generator) · *depends on:* S1.4 · *gates:*
  (1) every rule Q1–Q8 is a heading; (2) the document names the two input paths and the generator path verbatim;
  (3) `bun run lint:docs` exits 0 · *problems:* the lint rejects the name → the name is `YYYY-MM-DD-HH-MM-slug.md`, so a
  rejection means the timestamp was altered · *escalation:* none · *failure:* the scores have no stated meaning; undo by
  deleting the file · *returns:* the path.

**Stage gate A.** `bun scripts/evidence/derive-quality.ts --check` exits 0 in `{worktree}`, the table holds ≥ 100 entries
each with an `https` source and a date, and the two reference documents exist and pass `bun run lint:docs`.

### Stage B — Design trees

**Why.** AGENTS.md §6.1 and §6.2 require the product tree and the architecture tree before any code, and the spend-report
precedent (`{repo}/docs/design/2026-11-06-15-21-spend-report-{product,architecture}.md`) is the shape to follow.

**What.** Two documents that fix every name, every port, every test path and every acceptance mapping this plan then
implements.

- **S2.1** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/docs/design/2026-11-11-03-17-cheapest-routing-product.md` · *content:* the spend-report product structure:
  `## 1. Purpose` (the measured table of §1 and the arithmetic); `## 2. Use cases` with `### uc-1` … `### uc-7`, each
  carrying its tag line `feature=routing use-case=uc-N dependency=…` and a `**Negative:**` bullet; `## 3. Configuration
  surface` (the YAML block, key by key, with defaults); `## 4. Data and states` (the seven decision reasons `unknown-quality`,
  `subscription-flat-fee`, `unpriced-requested`, `no-candidate`, `cheapest-similar`, `requested-is-cheapest`,
  `stale-format`, each with the condition that produces it, plus the state with no decision at all — routing disabled or
  `x-proxy-route: requested` — which writes no header and no record; the price basis; the headers); `## 5. Acceptance criteria` mapping every uc to its test file · *depends on:* Stage A · *gates:* (1) seven
  `### uc-N` headings; (2) seven `**Negative:**` bullets; (3) the acceptance table names only test paths that §6 of this
  plan creates · *problems:* a uc without a negative → the document is incomplete; add it before proceeding · *escalation:*
  none · *failure:* the implementation has no contract; undo by deleting the file · *returns:* the path and the uc list.
- **S2.2** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/docs/design/2026-11-11-03-17-cheapest-routing-architecture.md` · *content:* the spend-report architecture
  structure, one section per layer, each with a `name | responsibility` table, its public interface, its dependencies
  (abstractions only), the ucs it serves and its test path: §1 domain `model-quality.ts`; §2 domain `model-routing.ts`;
  §3 domain `services/request-shape.ts`; §4 port `ports/outbound/model-routing.ts`; §5 application
  `application/model-routing-service.ts`; §6 application `passthrough-service.ts` (the changed call order); §7 inbound
  adapter `route-handler.ts` (the header constants); §8 composition `container.ts` (the single wiring point); §9 the
  generator `scripts/evidence/derive-quality.ts` · *depends on:* S2.1 · *gates:* (1) every layer section names its file
  path and its test path; (2) no section names a class that §6 does not create; (3) `bun run lint:docs` exits 0 · *problems:*
  a section names a file that the plan's inventory lacks → fix the plan, not the document · *escalation:* none ·
  *failure:* the code's structure is undecided; undo by deleting the file · *returns:* the path.

**Stage gate B.** Both design documents exist, the product document's seven ucs each carry a negative scenario, and
`bun run lint:docs` exits 0.

### Stage C — Domain: the pure rule, the table, the config

**Why.** The decision must be a pure function so it is provable at 100 % coverage with no I/O, and the config must be
parsed as strictly as every other key.

**What.** `model-routing.ts`, `request-shape.ts`, the `routing` block in `config.ts`, the example YAML, and the unit tests
that pin every branch.

- **S3.1** — *runs in:* subagent · *action:* create · *target:* `{repo}/packages/core/src/domain/model-routing.ts` ·
  *content:* the exported types `RoutePolicy` (`enabled`, `tolerancePoints`, `inputOutputRatio`, `withholdFrom`,
  `includeSubscription`, `moveOffSubscription`, `quality` overrides), `RouteCandidate` (`id`, `provider`, `model`, `formats`, `cost?`,
  `contextWindow?`, `maxOutputTokens?`, `toolCall?`, `input?`, `status?`, `quality?`), `RequestShape` (`needsTools`,
  `needsImage`, `needsPdf` each `boolean`, `outputTokens?`), `RequestedModel` (`provider`, `model`, `cost?`, `quality?`),
  `RouteDecision` (`target`, `reason`, `considered`, `qualityGap?`, `price?`, `priceBasis`) with
  `reason` exactly one of the seven states of the product document (`unknown-quality`, `subscription-flat-fee`,
  `unpriced-requested`, `no-candidate`, `cheapest-similar`, `requested-is-cheapest`, `stale-format`); and two functions:
  `weightedPrice(cost, ratio)` returning `cost.input * ratio + cost.output`, and
  `selectRoute(requested, shape, format, candidates, policy)`, which is only ever called when routing is enabled (the
  caller decides that; a disabled policy and an overridden request produce no decision object at all), applying in this
  order: (1) `requested.quality` undefined → `unknown-quality`;
  (2) `SUBSCRIPTION_PROVIDERS` holds `requested.provider` and `policy.moveOffSubscription` is false →
  `subscription-flat-fee`; (3) `requested.cost` undefined and step 2 did not apply → `unpriced-requested`;
  (4) drop every candidate that fails `withheld`/`includeSubscription`/no `cost`/`status === "deprecated"`/format not in
  `formats`/quality undefined/`quality < requested.quality - tolerancePoints`/`needsTools && toolCall !== true`/
  `needsImage && !input.includes("image")`/`needsPdf && !input.includes("pdf")`/`outputTokens` greater than a known
  `maxOutputTokens` or a known `contextWindow`; (5) sort by `weightedPrice` asc, `quality` desc, `PROVIDER_IDS` index asc,
  model id asc; (6) empty → `no-candidate`; (7) the first candidate is the requested model → `requested-is-cheapest`;
  (8) otherwise `cheapest-similar` with its `qualityGap` and `price`. Steps 2 and 3 guarantee the requested model is priced
  whenever a comparison could matter, so the sort never has to compare against an unknown requested price · *depends on:* Stage B · *gates:* (1) the module
  imports only `@accounts-proxy/core/domain/*` (`grep -n "from \"" ... | grep -v "@accounts-proxy/core/domain"` prints
  nothing); (2) `bun x tsc --noEmit -p tsconfig.json` exits 0 · *problems:* a candidate naming a provider outside
  `PROVIDER_IDS` → the type rejects it; a tie-break needing the clock → forbidden, use only the four keys · *escalation:*
  a rule that cannot be decided from the data → stop and ask, never invent a default · *failure:* no decision function;
  undo by deleting the file · *returns:* the exported signatures.
- **S3.2** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/packages/core/src/domain/services/request-shape.ts` · *content:* `requestShape(format: WireFormat, body: string):
  RequestShape | undefined` — parse the JSON once; `undefined` for a malformed or non-object body (the caller then forwards
  unchanged). Field mapping, exact: `anthropic-messages` → tools from a non-empty `tools` array, image from any
  `messages[].content[]` of `type: "image"`, pdf from `type: "document"`, output from `max_tokens`; `openai-chat` → tools
  from `tools` or `functions`, image from any content part `type: "image_url"`, output from `max_completion_tokens` ?? `max_tokens`;
  `openai-responses` → tools from `tools`, image from an `input[]` item of `type: "input_image"`, output from
  `max_output_tokens`; `gemini` → tools from `tools`, image/pdf from `inlineData`/`fileData` with an `image/*` or
  `application/pdf` mimeType, output from `generationConfig.maxOutputTokens`. A non-numeric or non-positive output limit is
  absent, never coerced · *depends on:* S3.1 · *gates:* (1) `bun x tsc` exits 0; (2) the module is pure: no `import` outside
  `@accounts-proxy/core/domain`; (3) a malformed body answers `undefined` in the unit test · *problems:* a dialect whose
  real requests use a field this list misses → the shape under-reports and the router is conservative (safe); a
  mis-mapped field would over-report → the unit test must use one captured example per format from
  `{repo}/tests/fixtures/captures/` · *escalation:* a capture contradicting this list → ask which is authoritative ·
  *failure:* a wrong shape routes around a real constraint; undo by deleting the file · *returns:* the mapping table as
  implemented.
- **S3.3** — *runs in:* subagent · *action:* edit · *target:* `{repo}/packages/core/src/domain/config.ts` · *content:* add
  `RoutingSettings` and `DEFAULT_ROUTING = { enabled: false, tolerancePoints: 3, inputOutputRatio: 10, withholdFrom: [],
  includeSubscription: false, moveOffSubscription: false, quality: {} }`; add `routing` to `ProxyConfig` and to `DEFAULT_CONFIG`; add `"routing"` to
  the `only(raw, […])` list at the document level (line 59); add `parseRouting(raw.routing)` validating exactly:
  `enabled` a boolean; `tolerancePoints` a number ≥ 0; `inputOutputRatio` a number ≥ 1; `withholdFrom` an array of known
  `ProviderId`s with no duplicates; `includeSubscription` a boolean; `moveOffSubscription` a boolean; `quality` a mapping of `<provider>/<model>` (validated
  by `resolveModelAddress`) to a number in `[0, 100]`; every unknown sub-key rejected by `only(...)`. Extend the header
  comment with the plan reference and defaults · *depends on:* S3.1 · *gates:* (1) `bun x tsc` exits 0; (2) the default
  document exports `enabled: false`; (3) `parseProxyConfig({ routing: { tolerancePoints: -1 } })` throws `ConfigError`
  naming `routing.tolerancePoints` · *problems:* a key added to `ProxyConfig` without a `DEFAULT_CONFIG` entry breaks every
  fixture → fixed by the same edit · *escalation:* none · *failure:* the feature cannot be configured; undo with
  `git -C {worktree} checkout -- packages/core/src/domain/config.ts` · *returns:* the key list and the defaults.
- **S3.4** — *runs in:* subagent · *action:* edit · *target:* `{repo}/config/proxy.example.yaml` · *content:* after the
  `logs` block, add the `routing` block with every key at its default value plus one comment per key: `enabled: false`
  (with "the feature is off; no request is ever sent to another model"), `tolerancePoints: 3` ("quality points a candidate
  may sit below the requested model"), `inputOutputRatio: 10` ("the input weight of the price `input × ratio + output`, per
  million tokens"), `withholdFrom: []` ("providers never chosen as a candidate"), `includeSubscription: false` ("count
  subscription cells as price 0; off, they are never candidates"), `moveOffSubscription: false` ("let a request naming a
  subscription model be answered by a priced gateway model; off, a request already paid for is never moved"),
  `quality: {}` ("`<provider>/<model>` → score, overrides
  the committed table") · *depends on:* S3.3 · *gates:* (1) `bun -e "import {parseProxyConfig} from
  './packages/core/src/domain/config.ts'; import {readFileSync} from 'node:fs'; import {YAML} from 'bun';
  console.log(JSON.stringify(parseProxyConfig(YAML.parse(readFileSync('config/proxy.example.yaml','utf8'))).routing))"`
  prints the defaults of S3.3; (2) no provider entry changed · *problems:* YAML `{}` parses as an empty map, not a string →
  the gate proves it · *escalation:* none · *failure:* the example drifts from the parser; undo with `git checkout` ·
  *returns:* the parsed defaults.
- **S3.5** — *runs in:* subagent · *action:* create · *target:* `{repo}/packages/core/tests/unit/model-routing.test.ts` ·
  *content:* one `describe` per rule of S3.1 — a table-driven case for each of the seven decision states (including a
  subscription request with `moveOffSubscription` false and true, and an unpriced `cheaper-inference` request), one case
  per disqualifier (withheld, subscription excluded and included, unpriced candidate, deprecated, format, unknown quality,
  band below, tools, image, pdf, output limit, context limit), both tie-break levels, and `weightedPrice` at ratio 1 and
  10 · *depends
  on:* S3.1 · *gates:* (1) `bun scripts/gate/run-tests.ts unit --workspace packages/core` exits 0; (2) coverage of
  `model-routing.ts` is `100` on lines, statements, functions and branches · *problems:* an unreachable branch → the gate
  names the line; simplify the code, never the test · *escalation:* a branch unreachable by design → rewrite the rule, not
  the gate · *failure:* the rule is unproven; undo by deleting the test · *returns:* the case count and the coverage line.
- **S3.6** — *runs in:* subagent · *action:* create · *target:* `{repo}/packages/core/tests/unit/request-shape.test.ts` ·
  *content:* one case per format, each built from a real capture body under `{repo}/tests/fixtures/captures/` (Anthropic
  Messages with tools and one image, OpenAI Chat with `image_url` and `max_completion_tokens`, Responses with
  `input_image` and `max_output_tokens`, Gemini with `inlineData` image and `generationConfig.maxOutputTokens`), plus
  malformed JSON, a non-object body, an empty `tools` array, and a zero/negative limit · *depends on:* S3.2 · *gates:*
  (1) the unit run exits 0; (2) `request-shape.ts` coverage is 100 % on all four metrics · *problems:* a fixture without
  the field under test → add the field only in the test body, never by editing a capture · *escalation:* none · *failure:*
  the shape is unproven; undo by deleting the test · *returns:* the case count.
- **S3.7** — *runs in:* subagent · *action:* create · *target:* `{repo}/packages/core/tests/unit/model-quality.test.ts` ·
  *content:* asserts every entry has a finite score in `[0, 100]`, a `source` starting `https://`, a `date` matching
  `^\d{4}-\d{2}-\d{2}$`; that no key contains `/` or `:`; that the table is non-empty; and that `qualityOf(model, overrides)`
  prefers the override, falls back to the exact key, then to the suffix-normalised key (`-extra-low|low|medium|high|tiered`
  stripped, the same list as `resolveReferenceEntry`), then answers `undefined` · *depends on:* S1.4 · *gates:* (1) the
  unit run exits 0; (2) `model-quality.ts` reports 100 % on all four metrics (the table is data; the accessor is code)
  · *problems:* a hand edit to a generated row → `--check` fails in Stage A; the two gates together prevent drift ·
  *escalation:* none · *failure:* provenance is unproven; undo by deleting the test · *returns:* the entry count.
- **S3.8** — *runs in:* subagent · *action:* edit · *target:*
  `{repo}/packages/core/tests/unit/config-and-oauth.test.ts` · *content:* add to the rejection table: `routing` not a
  mapping; `routing.enabled` non-boolean; `tolerancePoints` negative and non-numeric; `inputOutputRatio` 0;
  `withholdFrom` an unknown provider, a non-array, a duplicate; `includeSubscription` non-boolean; `moveOffSubscription` non-boolean; `quality` a non-mapping,
  a non-`<provider>/<model>` key, a value above 100, a value below 0, a string value; an unknown `routing.*` key; and one
  acceptance case asserting the full default block · *depends on:* S3.3 · *gates:* (1) the unit run exits 0; (2) the table
  holds the new rows · *problems:* an assertion written against the error's text → assert the `ConfigError` message prefix
  `proxy.yaml: routing.` instead · *escalation:* none · *failure:* the parser is unproven; undo with `git checkout` ·
  *returns:* the new row count.

**Stage gate C.** `bun scripts/gate/run-tests.ts unit --workspace packages/core` exits 0; `model-routing.ts`,
`request-shape.ts`, `model-quality.ts` and the changed `config.ts` each report 100 % on lines, statements, functions and
branches; `bun x tsc --noEmit -p tsconfig.json` exits 0.

### Stage D — Port, application service, call order, observability

**Why.** The decision must run once per inference request, inside the hexagon, before any upstream call, and its result
must be visible to the client and to the log.

**What.** The outbound port, the caching application service, the changed `PassthroughService`, the exchange-log record
kind, the header constants and the composition wiring.

- **S4.1** — *runs in:* subagent · *action:* create · *target:* `{repo}/packages/core/src/ports/outbound/model-routing.ts` ·
  *content:* `export abstract class ModelRoutingPort { abstract decide(format: WireFormat, address: ModelAddress, shape:
  RequestShape | undefined, override: "cheapest" | "requested" | undefined): Promise<RouteDecision | undefined> }`, where
  `undefined` means "no decision was made" and the caller forwards the requested model untouched; importing only
  `@accounts-proxy/core/domain/*` · *depends on:* Stage C · *gates:* (1) `bun x tsc` exits 0; (2) the arch test
  `bun test tests/arch` exits 0 (a port may import only domain) · *problems:* the arch test rejects an external import →
  the file has none by content · *escalation:* none · *failure:* no seam; undo by deleting the file · *returns:* the
  signature.
- **S4.2** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/apps/proxy/src/application/model-routing-service.ts` · *content:* `class ModelRoutingService extends
  ModelRoutingPort`, constructor `(describe: DescribeModelsPort, settings: RoutingSettings, clock: ClockPort,
  maxAgeMs: number, providerOrder: readonly ProviderId[])`; a single in-flight promise so N concurrent requests cause one
  `describeModels()`; the projection is rebuilt when `clock()` exceeds `maxAgeMs` or after `refresh()` is called.
  `decide` answers `undefined` immediately when `settings.enabled` is false, when `override === "requested"`, or when
  `shape` is `undefined` — the three states that make no decision at all; otherwise it builds `RouteCandidate[]` from every
  `DetailedModel` of every catalog (skipping catalogs whose `source` is `"unavailable"`), resolves the requested quality
  from the `routing.quality` override then the table, and calls `selectRoute` with the format and shape. `refresh()` is
  called by `RefreshModelsService` after a list refresh; the re-check of `provider.nativeFormats` for the chosen model
  happens here and downgrades to the requested model with `stale-format` when the provider refuses · *depends on:* S4.1, Stage C · *gates:* (1) `bun x tsc` exits 0; (2) the
  application→adapters arch rule holds (`bun test tests/arch` exits 0); (3) a component test proves one `describeModels()`
  call for ten decisions · *problems:* a catalog in `unavailable` state shrinks the candidate set → recorded, not fatal;
  a `describeModels()` throw → caught, decision `no-candidate`, request forwarded · *escalation:* none · *failure:* a
  catalog read per request (a measured regression) → the component gate catches it · *returns:* the call counts.
- **S4.3** — *runs in:* subagent · *action:* edit · *target:*
  `{repo}/apps/proxy/src/application/passthrough-service.ts` · *content:* constructor gains `private readonly routing:
  ModelRoutingPort`; `forward` becomes: resolve the address (unchanged, first), compute `requestShape(format,
  request.body)`, read the `x-proxy-route` override from `request.headers`, call `routing.decide(...)` **before**
  `provider.nativeFormats`, and use `decision.target` in place of the address for the disabled-provider check, the format
  check and the `passthrough` call. When `decide` answers a decision, set the four response headers on the returned
  `HttpResponse.headers` (the five constants exported in S4.5: `ROUTED_FROM_HEADER` = requested, `ROUTED_TO_HEADER` =
  chosen only when different, `ROUTE_REASON_HEADER` = `decision.reason`, `ROUTE_PRICE_HEADER` = `decision.priceBasis`)
  and write one `route-decision` entry through the injected `ExchangeSinkPort` when one is present. When `decide` answers
  `undefined` the path is exactly today's: no header, no record, the requested model. The response **body** is never
  touched · *depends on:* S4.2 · *gates:* (1) `bun x tsc` exits 0; (2) an existing test asserting the three error cases
  (unknown model, disabled provider, untranslatable format) still passes with the same error types and order; (3)
  `git -C {worktree} diff --stat` names only this file · *problems:* setting a header on a streamed response after the
  first byte → headers are set before returning, never later; a `Headers` object shared with a cached response → each
  upstream call returns a fresh object (asserted in the component test) · *escalation:* none · *failure:* every request
  changes behaviour when routing is off → the default-off gate catches it · *returns:* the new signature.
- **S4.4** — *runs in:* subagent · *action:* edit · *target:* `{repo}/packages/core/src/domain/exchange-log.ts` ·
  *content:* add `"route-decision"` to `ExchangeKind` and document the entry's fields in the file header: `requested`,
  `chosen`, `reason`, `considered`, `qualityGap?`, `price?`, `priceBasis`; the entry carries `kind`, `id` (the client
  exchange id) and `exchange`, and no body and no headers, so `redactEntry`'s response branch applies unchanged · *depends
  on:* S4.3 · *gates:* (1) `bun x tsc` exits 0; (2) `bun test tests/arch` exits 0; (3) a component test writes one entry and
  reads it back from the sink fake · *problems:* a sink that rejects an unknown kind → the sink is typed by `ExchangeKind`,
  so the union change compiles the writers · *escalation:* none · *failure:* decisions are unauditable; undo with
  `git checkout` · *returns:* the field list.
- **S4.5** — *runs in:* subagent · *action:* edit · *target:*
  `{repo}/apps/proxy/src/adapters/inbound/http/route-handler.ts` · *content:* export the five constants
  `ROUTE_OVERRIDE_HEADER = "x-proxy-route"`, `ROUTED_FROM_HEADER = "x-proxy-routed-from"`, `ROUTED_TO_HEADER =
  "x-proxy-routed-to"`, `ROUTE_REASON_HEADER = "x-proxy-route-reason"`, `ROUTE_PRICE_HEADER = "x-proxy-route-price"`;
  extend the file's route-table comment with the override. No other change: the handler already passes the headers through
  and `PassthroughService` reads them · *depends on:* S4.3 · *gates:* (1) `bun x tsc` exits 0; (2) `grep -c "export const
  ROUTE" {worktree}/apps/proxy/src/adapters/inbound/http/route-handler.ts` prints `5` · *problems:* a constant declared but
  never documented fails the docs-in-step test in Stage E — that is the intended order · *escalation:* none · *failure:* the
  names have no single source; undo with `git checkout` · *returns:* the five names.
- **S4.6** — *runs in:* subagent · *action:* edit · *target:* `{repo}/apps/proxy/src/composition/container.ts` ·
  *content:* in `buildRoutes`, construct `const routing = new ModelRoutingService(describe, graph.config.routing,
  graph.clock, modelListMaxAgeMs(graph.config), PROVIDER_IDS)` and pass it to `PassthroughService` together with
  `graph.exchangeLog?.sink`; in `RefreshModelsService`'s construction site, call `routing.refresh()` after a successful
  refresh (the service exposes it) · *depends on:* S4.2, S4.4 · *gates:* (1) `bun x tsc` exits 0; (2) `bun run verify`'s
  typecheck step passes later in Stage G; (3) `grep -n "new ModelRoutingService" {worktree}/apps/proxy/src/composition/container.ts`
  prints exactly one line · *problems:* `graph.clock` absent → read `ProviderGraph` and use the clock the exchange log
  already receives; a second composition root in `scripts/evidence/live` → the same wiring must be added there, and the
  step's diff names it · *escalation:* a composition point whose deps differ → ask before inventing a second path ·
  *failure:* the daemon has routing but the evidence harness does not; undo with `git checkout` · *returns:* the wiring
  lines.

**Stage gate D.** `bun x tsc --noEmit -p tsconfig.json` exits 0; `bun test tests/arch` exits 0; the component suite
`apps/proxy/tests/component/model-routing-service.test.ts` passes with one `describeModels()` call for ten decisions; the
three existing passthrough error cases pass unchanged.

### Stage E — Documents in step

**Why.** §7 of `AGENTS.md` and `apps/proxy/tests/unit/docs-in-step.test.ts` bind every header, config key, limit and
diagram name to the reference documents; a stale document fails the release gate.

**What.** The API reference, the OpenAPI document, the providers reference, the diagram, the README and `AGENTS.md` in
step with the code.

- **S5.1** — *runs in:* subagent · *action:* edit · *target:* `{repo}/docs/reference/2026-10-17-19-26-proxy-api.md` ·
  *content:* §3 route table unchanged; §4 gains one row per new header with its meaning (`x-proxy-route` a request header
  with values `cheapest|requested`; `x-proxy-routed-from`, `x-proxy-routed-to`, `x-proxy-route-reason`,
  `x-proxy-route-price` response headers, the last stating `input×ratio+output` per million from the base tier); §7 gains
  one row per new key under a `routing.*` group with its type and default; §8 gains the `route-decision` record kind with
  its seven reason values; §10 gains the `routing` decision deadline statement that a decision adds no upstream call ·
  *depends on:* Stage D · *gates:* (1) `grep -c "x-proxy-route" …` prints ≥ 5; (2) `bun run lint:docs` exits 0 ·
  *problems:* a header name drifted from S4.5 → the docs-in-step test fails in S5.3, which is the gate · *escalation:* none
  · *failure:* the release gate fails; undo with `git checkout` · *returns:* the row count.
- **S5.2** — *runs in:* subagent · *action:* edit · *target:*
  `{repo}/docs/reference/2026-10-17-19-26-proxy-openapi.json` · *content:* add four entries under `components.headers`
  (`RoutedFrom`, `RoutedTo`, `RouteReason`, `RoutePrice` — the last with an `enum` of the seven reasons) and
  reference them from the `headers` object of every operation that answers an inference request (the four inference
  operations and `count_tokens`); add one parameter `RouteOverride` (in `header`, name `x-proxy-route`, `enum`
  `[cheapest, requested]`) referenced by the same operations. The OpenAPI document covers HTTP only, so `proxy.yaml`
  gains no schema here · *depends on:* S5.1 · *gates:* (1) the JSON parses; (2) `grep -c "x-proxy-routed" …` prints
  ≥ 2; (3) every `$ref` resolves (the docs-in-step test asserts this) · *problems:* a `$ref` to a missing schema → the
  test names it · *escalation:* none · *failure:* the OpenAPI document lies; undo with `git checkout` · *returns:* the new
  component names.
- **S5.3** — *runs in:* subagent · *action:* edit · *target:*
  `{repo}/apps/proxy/tests/unit/docs-in-step.test.ts` · *content:* import the five constants from the route handler and add
  them to the header list asserted at line 148, so the test proves each appears in the API table and in the OpenAPI JSON ·
  *depends on:* S5.1, S5.2 · *gates:* (1) `bun scripts/gate/run-tests.ts unit` exits 0; (2) the test fails when one header
  row is deleted from the API reference (prove by temporary edit, then revert) · *problems:* the test imports a constant
  that does not exist → S4.5 must be green first · *escalation:* none · *failure:* the binding is missing; undo with
  `git checkout` · *returns:* the asserted list.
- **S5.4** — *runs in:* subagent · *action:* edit · *target:* `{repo}/docs/reference/2026-10-17-19-26-providers.md` ·
  *content:* one sentence per provider in its section stating its candidacy: `claude`, `antigravity` and `openai` carry no
  price (rule M5) and are candidates only with `routing.includeSubscription: true`; `openrouter`, `opencode` and
  `opencode-go` are candidates for every priced model; `cheaper-inference` states no price and is never a candidate ·
  *depends on:* S5.1 · *gates:* (1) each of the seven provider headings contains the word `candidate`; (2)
  `bun run lint:docs` exits 0 · *problems:* the heading test at `docs-in-step.test.ts:212` requires exactly `## <id>` → add
  the sentence below the heading, never change it · *escalation:* none · *failure:* the document misleads; undo with
  `git checkout` · *returns:* the sentence count.
- **S5.5** — *runs in:* subagent · *action:* edit · *target:* `{repo}/docs/architecture.drawio` · *content:* on the
  `Request flow` page only, insert one node labelled `ModelRoutingService` between `RouteHandler` and `PassthroughService`
  with the edge label `decide`, and one edge from it to `DescribeModelsService` labelled `catalog (cached)`. No
  `NAME = number` cell is added or removed (the test asserts an exact count), no page is added (the page list is exact) ·
  *depends on:* Stage D · *gates:* (1) `bun scripts/gate/run-tests.ts unit` exits 0, including the diagram name and page
  assertions; (2) `grep -c "ModelRoutingService" {worktree}/docs/architecture.drawio` prints ≥ 1 · *problems:* the new
  label's CamelCase token is not a declared class → S4.2 declares exactly that name; a stray number cell breaks the exact
  count → the gate names it · *escalation:* none · *failure:* the diagram disagrees with the code; undo with
  `git checkout` · *returns:* the node and edge added.
- **S5.6** — *runs in:* subagent · *action:* edit · *target:* `{repo}/README.md` and `{repo}/AGENTS.md` · *content:*
  README: one `### Routing to the cheapest similar model` subsection under configuration, with the YAML block, the five
  headers, the seven reasons and a worked example (a request for `opencode/muse-spark-1.2` answered by `openrouter/inclusionai/ling-3.1-flash` at
  27.8× less input price, 0.09 composite points lower); AGENTS.md §2 gains law **L6**: "Routing is opt-in
  (`routing.enabled`, default false) and can only move a request to a model that accepts its format natively, whose
  quality is known and within `tolerancePoints`, whose price is known, and whose declared capabilities cover the request;
  any doubt forwards the requested model and records the reason — routing never fails a request" · *depends on:* S5.1 ·
  *gates:* (1) `bun run lint:docs` exits 0 (README's link table unchanged); (2) `grep -c "routing.enabled" README.md`
  prints ≥ 1; (3) `grep -c "L6" AGENTS.md` prints ≥ 1 · *problems:* the README link test asserts the six reference links,
  untouched here · *escalation:* none · *failure:* documentation lags; undo with `git checkout` · *returns:* the section
  path.

**Stage gate E.** `bun scripts/gate/run-tests.ts unit` exits 0 (docs-in-step included), `bun run lint:docs` exits 0, the
drawio has the same four pages and the same number of `NAME = number` cells, and every new name appears in both the API
reference and the OpenAPI document.

### Stage F — Tests at every tier

**Why.** §6.5 and §6.6 require one component suite per feature, one live suite per external dependency, e2e at the end,
and a negative scenario per use case per tier.

**What.** Component, e2e and live suites that prove the seven use cases end to end.

- **S6.1** — *runs in:* subagent · *action:* create · *target:*
  `{repo}/apps/proxy/tests/component/model-routing-service.test.ts` · *content:* the unit's fake `DescribeModelsPort`
  returning two catalogs with known prices and scores; cases: one `describeModels()` call for ten decisions; the cache
  expires after `maxAgeMs` and `describeModels()` is called again; `refresh()` forces a rebuild; an `unavailable` catalog
  is skipped and the decision still answers; uc-1, uc-2, uc-3, uc-6 and uc-7 each with its negative · *depends on:* Stage D
  · *gates:* (1) the component run exits 0; (2) `model-routing-service.ts` reports 100 % on all four metrics · *problems:*
  a fake that mirrors the real catalog too loosely → build it from the committed snapshot's shape (S1.2) ·
  *escalation:* none · *failure:* the service is unproven; undo by deleting the file · *returns:* the case count.
- **S6.2** — *runs in:* subagent · *action:* create · *target:* `{repo}/apps/proxy/tests/component/route-headers.test.ts` ·
  *content:* uc-5: a `RouteDecision` produces exactly the four response headers with the seven reason values, no header
  when routing is off, and one `route-decision` entry with the documented fields; the negative case: an overridden request
  writes no record · *depends on:* S4.3, S4.4 · *gates:* (1) the component run exits 0; (2) the covered lines of
  `passthrough-service.ts` reach 100 % across the unit and component tiers together · *problems:* the sink fake shared with
  another test → keep it local to the file · *escalation:* none · *failure:* observability is unproven; undo by deleting the
  file · *returns:* the case count.
- **S6.3** — *runs in:* subagent · *action:* create · *target:* `{repo}/apps/proxy/tests/component/quality-extract.test.ts` ·
  *content:* the transcription audit: for every entry of `QUALITY_SCORES`, find the extract row with the same normalised
  id and assert the score and the `source` slug match; assert the entry count equals the number of distinct joined ids;
  the negative: a planted wrong score fails the test (proved by a temporary edit, then reverted) · *depends on:* S1.4 ·
  *gates:* (1) the component run exits 0; (2) the assertion count equals the table's entry count · *problems:* the extract
  format changes → the parser in the test fails loudly · *escalation:* none · *failure:* the table may hold a typo; undo by
  deleting the test · *returns:* the assertion count.
- **S6.4** — *runs in:* subagent · *action:* create · *target:* `{repo}/apps/proxy/tests/e2e/routing.test.ts` · *content:*
  a daemon in its own process (`tests/support/e2e/proxy-process.ts`) with scripted catalogs on the replay upstreams and a
  `proxy.yaml` per case. Ten cases: uc-1 an Anthropic Messages request for a dear model is answered by the cheapest
  similar one — asserted on `upstreams.requests` (the body's `model` is the chosen one) and on the four response headers;
  uc-2 a request whose model has no score forwards unchanged with reason `unknown-quality` and answers 200; uc-3 a request
  carrying `tools` never reaches a candidate with `toolCall` unset (asserted on the recorded requests); uc-4
  `x-proxy-route: requested` forwards unchanged and writes no `route-decision`; uc-5 the usage log holds exactly one
  `route-decision` record with its fields; uc-6 a `withholdFrom` naming the cheapest provider's id picks the next
  cheapest; uc-7 a catalog advertising a format the provider refuses falls back with `stale-format` and answers 200; plus
  three guard cases: a disabled-routing request whose upstream body equals the requested model with no header set; a
  subscription-model request that stays put with reason `subscription-flat-fee` and moves only with
  `moveOffSubscription: true`; and a `cheaper-inference` request that stays put with reason `unpriced-requested` · *depends on:*
  Stage D, S6.1 · *gates:* (1) `bun scripts/gate/run-tests.ts e2e` exits 0; (2) the e2e coverage gate reports 100 % on all
  four metrics; (3) every case asserts on `upstreams.requests`, never on a log line alone · *problems:* the replay server
  answers by path, so the chosen model must be visible in the recorded body → assert there, not in the answer; a case
  needing a second upstream → script the second path explicitly · *escalation:* a capture that cannot represent the chosen
  model → use a scripted responder returning a minimal documented answer · *failure:* the feature is unproven end to end;
  undo by deleting the file · *returns:* the case list and the coverage figures.
- **S6.5** — *runs in:* subagent · *action:* create · *target:* `{repo}/apps/proxy/tests/live/routing-catalogs.test.ts` ·
  *content:* the real-catalog tier: with `ACCOUNTS_PROXY_LIVE=1`, describe every enabled provider's live list and assert
  (a) every candidate provider's models carry a numeric `cost`, (b) for five reference addresses measured on 2026-11-10
  (`opencode/muse-spark-1.2`, `openrouter/anthropic/claude-opus-5.5`, `openrouter/deepseek/deepseek-v4-pro-0813`,
  `opencode-go/muse-spark-1.3-contributor`, `openrouter/z-ai/glm-5.3`), the decision is a property, not a fixed id: a
  `cheapest-similar` answer's weighted price is at most the requested model's weighted price, its quality gap is within
  `tolerancePoints`, and its provider accepts the request's format; (c) every model of `QUALITY_SCORES` that appears in a
  live catalog still appears (no silent rename). The negative: a catalog missing a provider (simulated by describing one
  provider only) yields `no-candidate`, never a throw · *depends on:* S6.1 · *gates:* (1) `bun run test:live` exits 0 with the real accounts; (2) the run's output is
  pasted into the session record · *problems:* an expired credential → the tier reports it and the plan reports the step as
  blocked, never as passed · *escalation:* ask the user to run `bun run proxy login <provider>` · *failure:* the real
  catalogs are unverified; the step stays open · *returns:* the measured prices of the chosen pair.

**Stage gate F.** Component, e2e and live suites all pass; the e2e gate reports 100 % on every metric; the live output is
recorded in the session.

### Stage G — Release gate and record

**Why.** §3.8 and §3.9 close the plan only on a green, recorded final gate.

**What.** The full gate, a secret audit, a commit on the feature branch, the merge decision, and the session record.

- **S7.1** — *runs in:* main session · *action:* run · *target:* `{worktree}` · *content:* `bun run verify`, output to
  `/tmp/opencode/final-verify.log` · *depends on:* Stage F · *gates:* (1) exit 0; (2) typecheck, unit+component+arch
  coverage, build, e2e coverage, merged coverage and docs lint each report their 100 % figures; (3) the merged coverage
  reports 100 % on all four metrics · *problems:* a pre-existing failure from the baseline → compare with
  `/tmp/opencode/baseline-verify.log` and report it as pre-existing with both logs; a timeout under machine load →
  record the load (`uptime`), rerun once, then report · *escalation:* a new failure → fix in the plan's scope; a failure
  outside the scope → ask the user · *failure:* the plan is not complete; the step stays open · *returns:* the log path and
  the figures.
- **S7.2** — *runs in:* main session · *action:* run · *target:* `{worktree}` · *content:* the secret audit over the whole
  diff: `git -C {worktree} diff main...HEAD | grep -nEi "sk-[a-z0-9]{10}|eyJ[a-zA-Z0-9_-]{10}|xpl_|ghp_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY"` and the same over every created file · *depends on:* S7.1 · *gates:*
  (1) both greps print nothing; (2) the S1.2 snapshot contains no `authorization` value (grep `-i authorization` prints
  nothing, since the command line never writes it) · *problems:* a token captured in a fixture body → remove the file and
  regenerate with redaction · *escalation:* any hit → stop and ask the user · *failure:* a credential would be published;
  undo the commit · *returns:* the two empty results.
- **S7.3** — *runs in:* main session · *action:* run · *target:* `{worktree}` · *content:* `git -C {worktree} add -A &&
  git -C {worktree} commit -m "feat(routing): send a request to the cheapest similar-performance model"` · *depends on:*
  S7.2 · *gates:* (1) `git -C {worktree} show --stat HEAD` lists only files of §6; (2) `git -C {worktree} status
  --porcelain` prints nothing · *problems:* an untracked artefact from the harness (a coverage file) → confirm `.gitignore`
  covers it rather than adding it · *escalation:* a file outside §6 appears → ask whether to keep it · *failure:* the work
  is lost on cleanup; the commit stays on the branch · *returns:* the commit hash.
- **S7.4** — *runs in:* main session · *action:* run · *target:* `{repo}` · *content:* ask the user whether to merge
  `feat-cheapest-routing` into `main` or to push the branch and open a pull request; on a merge:
  `git -C {repo} merge --no-ff feat-cheapest-routing`, then `git -C {repo} push`, then
  `git -C {repo} worktree remove {worktree} && git -C {repo} worktree prune && git -C {repo} branch -d feat-cheapest-routing`
  · *depends on:* S7.3 · *gates:* (1) `git -C {repo} status --porcelain` prints nothing; (2) `git -C {repo} worktree list`
  lists only the main checkout; (3) `git -C {repo} log --oneline -1` names the merge commit · *problems:* a merge conflict
  → stop, never resolve silently; a pull-request preference → keep the branch until it merges · *escalation:* the user
  decides merge or PR, always (§7.5) · *failure:* two branches diverge; report the state · *returns:* the integration
  outcome.
- **S7.5** — *runs in:* main session · *action:* create · *target:* `{repo}/docs/sessions/ses_ef10d7fa0ffe2baUvsApfbHHPZ.md`
  · *content:* the session record with the plan path, every step `[x]` with the command and output that proved its gates,
  the baseline and final gate logs, the coverage figures, the commit hash, the integration outcome and the live-tier output
  · *depends on:* S7.4 · *gates:* (1) the file exists with the exact name; (2) every step of §8 is `[x]` or explicitly
  reported as blocked with evidence · *problems:* a step reported blocked is never marked done · *escalation:* none ·
  *failure:* continuity is lost; the file can be written later · *returns:* the path.

**Stage gate G.** `bun run verify` green and recorded, secret audit empty, the commit on the branch lists exactly the §6
files, the integration is done or the PR is open, and the session record is current.

## 9. Final gate and rollback

- **Final gate:** `bun run verify` exits 0 on the final tree with 100 % on every tier; `bun run test:live` green with the
  real accounts; the docs lint green; the secret audit empty.
- **Rollback of the feature at run time:** set `routing.enabled: false` (the default) in `{home}/proxy.yaml` and restart
  the daemon — no request is ever sent to another model, and the only visible residue is the four headers, which are also
  suppressed when routing is off.
- **Rollback of the change:** `git -C {repo} revert <merge commit>`; the new files are inert without the wiring in
  `container.ts`, so a revert needs no data migration.
- **No data migration** exists: the feature writes no state, and `{home}` is untouched by every step.

## 10. Risks

| Risk | Likelihood | Detection | Handling |
|---|---|---|---|
| A score is wrong or stale, so a cheaper but weaker model is chosen | medium | `quality-extract.test.ts` catches transcription only; a wrong *source* is a curation risk | `routing.quality` override per model; `tolerancePoints`; the decision is logged with the gap so a bad outcome is traceable |
| The candidate catalog is large (≈ 700 models) and `describeModels()` is uncached | high without the cache | the component test counts `describeModels()` calls | S4.2's promise cache with `modelListMaxAgeMs`; refreshed on `models --refresh` |
| A cheaper model answers differently (different tokenizer, different tool format) | medium | a client-visible behaviour change | the feature is opt-in and the four headers name the change; the requested model stays one config line away |
| The base-tier price misranks a long-context request | low | `x-proxy-route-price` names the basis | documented (D7); a context-tier-aware estimate is a later plan, not a guess made here |
| A routing decision breaks a client that validates response headers | very low | an e2e case | headers are additive; an unknown header is ignored by every HTTP client |
| 100 % coverage forces an artificial branch | medium | the coverage gate names the line | simplify the rule; never waive the gate |
| The plan's own scale slips | medium | the session record's checklist | stages are independently green; a stopped stage leaves the tree green with the feature off |

## 11. Approval

Approving this plan approves decisions **D1–D10** as written. Any change to a decision after approval is a plan edit, a
recomputed SHA-256 and a new approval — never an improvisation during build.
