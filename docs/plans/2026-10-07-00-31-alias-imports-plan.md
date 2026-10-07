# Plan: replace relative imports with `@` aliases (sources and tests)

Status: **proposed, awaiting approval**. Requested 2026-10-07: "use aliases with @ in the imports instead of relative imports, for all sources and tests".

## 1. Measured starting point

Measured by `docs/temp/count-imports.ts`, which walks every `.ts` file with `ts.preProcessFile`.

| Area | Relative specifiers | Files |
|---|---:|---:|
| `packages/*/src`, `apps/*/src` | 115 | 45 |
| Tests, same workspace (`packages/*/tests`, `apps/*/tests`, `tests/`) | 89 | 15 |
| Tests, crossing workspaces (`../../../core/src/...`, `../../../../tests/support/...`) | 23 | 5 |
| `scripts/` | 10 | 7 |
| Vendored parity references (`packages/*/tests/reference/**`) | 14 | 8 |

Sources already use workspace-name imports across workspaces: 122 `@inference-router/<ws>/...` imports in 31 files.

## 2. Resolution probe

Scratch workspace: `%TEMP%\opencode\alias-probe`, Bun 1.4.2, the repository's TypeScript 5.9.3, and the repository's `tsconfig` options.

| Question | Result |
|---|---|
| Does a package import itself by name (`@probe/a/domain/x.ts` from inside `@probe/a`, via `exports: {"./*": "./src/*"}`)? | Yes. `bun test` passes. |
| Does a `tsconfig` `paths` alias (`@a/*`, `@support/*`) work in Bun at runtime? | Yes. |
| Do the self-name, the `paths` alias and a relative path give one module (same class identity) at its real path, not under `node_modules`? | Yes. `X` is identical across all three; `import.meta.path` is `…\packages\a\src\domain\x.ts`. |
| Does a Bun `onLoad` plugin see aliased modules at their real path, once each? This is how `scripts/gate/instrument.ts` instruments coverage. | Yes. One `ONLOAD` per file, real paths, so the `SOURCE_FILTER` still matches. |
| Does `tsc --noEmit` resolve both forms? | Yes (`TSC-OK`). |
| Does `Bun.build` resolve both forms into one bundled module? | Yes. `success=true`, `sameClass=true`, one `class X` in the output. |

Not yet probed (step 0 measures it before anything is relied on):
- a workspace package rooted at `tests/support`;
- a nested `tsconfig` inside a vendored reference directory.

## 3. Options

**A. Workspace package names everywhere (recommended).**
- Every import names the package that owns the file:
  - `@inference-router/core/domain/errors.ts`
  - `@inference-router/provider-antigravity/adapters/outbound/antigravity-chat.ts`
  - `@inference-router/router/application/login-service.ts`
- Tests use the same form, including for their own workspace.
- The root test support becomes a workspace package `@inference-router/test-support` (`tests/support/package.json`, `exports: {"./*": "./*"}`), imported as `@inference-router/test-support/fakes.ts`.

Pros:
- One mechanism, already in use (122 imports) and already resolved by the architecture gate.
- No second mapping to keep in sync: `package.json` `exports` is the single source.
- Works without `tsconfig` in every consumer: Bun runtime, `tsc`, `Bun.build`, coverage `onLoad` (all measured).
- The specifier shows the owning workspace, which is what the layer gate checks.

Cons: long specifiers.

**B. Short `tsconfig` `paths` aliases**, the style of the source plugins (`@antigravity/*`, `@claude/*`, `@test/*`):
- `@core/*` → `packages/core/src/*`
- `@provider-claude/*`, `@provider-antigravity/*`, `@router/*`
- `@test-support/*` → `tests/support/*`

The 122 existing `@inference-router/...` imports would be rewritten too, so only one form exists.

Pros: short specifiers; consistent with the two source plugins.

Cons:
- A second mapping (`tsconfig` `paths`) duplicates the workspace layout, and the architecture gate must read it.
- An alias scope can shadow a real npm scope if such a package is ever installed.
- The package `exports` become unused.

**C. Hybrid:** workspace names across workspaces, short aliases inside a workspace. Two forms coexist. Not recommended.

## 4. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| Q1 | Option A, B or C | **A** |
| Q2 | `scripts/` too? Its 10 relative imports are sibling gate modules plus `tests/support` | **Yes**, so the rule has no exceptions apart from Q3. Scripts would import `@inference-router/test-support/...`. For gate siblings, a `scripts` workspace (`@inference-router/scripts`) would be needed, measured in step 0. |
| Q3 | Vendored parity references (`tests/reference/plugin-*`) | **Restore them byte-identical to the plugin sources**: keep the original `@claude/` / `@antigravity/` aliases and give each reference directory its own `tsconfig.json` with `paths` (step 0 measures whether Bun honours a nested `tsconfig`). `MANIFEST.json` then records zero rewrites. If the probe fails, keep the current relative rewrite and list it as the only exception. |

## 5. Execution steps (option A, all recommendations)

0. **Probes in the scratch workspace** (no repository change):
   - (a) a `tests/support` workspace package imported by name from `packages/*/tests` and from `scripts/`;
   - (b) a `scripts` workspace imported by name;
   - (c) a nested `tsconfig` with `paths` inside a reference directory, at Bun runtime and excluded from root `tsc`.

   Results are recorded in this plan. A failed probe falls back as stated in Q2/Q3, and I report it before going on.
1. **Close the in-flight P3c work first**, so the alias change is a separate, purely mechanical commit:
   - router `application` (`LoginService`, `AccountAdminService`, `UsageService`, `ListModelsService`);
   - outbound adapters (file stores, file lock, fetch transport, system, browser launcher, loopback callback server, terminal manual code, YAML config);
   - CLI driver, composition, `main/cli.ts`;
   - core additions (config, `oauth-flow`, usage ports).

   Unit + component tests already pass (33 router tests, 22 core tests). Then: run the unit coverage gate to 100% and complete, typecheck, the architecture gate and docs lint; commit and push; verify the remote SHA through the GitHub API.
2. **Workspace manifests:**
   - add `tests/support/package.json` (`@inference-router/test-support`) and, per Q2, `scripts/package.json` (`@inference-router/scripts`);
   - add both to root `workspaces`;
   - run `bun install`, keeping the lockfile and pins unchanged apart from the two workspace entries;
   - update `scripts/gate/scaffold-packages.ts` so it knows the new workspaces.
3. **Codemod** `scripts/evidence/alias-imports.ts`:
   - for every relative specifier, resolve the target file;
   - compute `@inference-router/<workspace>/<path below src or the workspace root>`;
   - rewrite only the string literal, at the position `ts.preProcessFile` reports;
   - print one line per rewrite.

   The run log goes to `docs/temp/`.
4. **Mechanical-diff proof:**
   - the number of rewritten specifiers must equal the step-1 inventory (sources + tests + scripts);
   - a script checks that every changed line in `git diff` is an `import`/`export … from` line;
   - no line outside import statements changes.
5. **Vendored references (Q3):** re-export both references with `vendor-reference.ts` in no-rewrite mode. Verify every file's git blob equals its `MANIFEST.json` source blob (`git hash-object`), and add the nested `tsconfig.json`.
6. **Architecture gate extended** (`tests/arch/architecture.test.ts`):
   - New rule R-ALIAS: no relative specifier in any `.ts` under `packages/*/{src,tests}`, `apps/*/{src,tests}`, `tests/`, `scripts/`. The only exclusion is `packages/*/tests/reference/**`.
   - Every workspace specifier in tests and scripts must resolve to an existing file (today only sources are resolved).
   - Layer rules stay unchanged.
   - Self-test: synthetic violations (one relative import, one unresolvable alias) must be reported, so the gate cannot silently pass.
7. **Full gate:**
   - typecheck;
   - architecture gate;
   - unit + component coverage at 100% lines, statements, functions and branches, and complete;
   - every parity test (provider-claude 44 cases, provider-antigravity 16);
   - docs lint;
   - a CLI smoke run against a scratch home.

   E2E and merged coverage still report INCOMPLETE, because no e2e tier exists yet. That is unchanged and not a pass.
8. **Documentation sync:**
   - `AGENTS.md` §2: the import law becomes "every import is `@inference-router/<workspace>/<subpath>`; relative imports are forbidden, except inside vendored references". It names the two new workspaces.
   - `README.md` layout and diagram.
   - `docs/architecture.drawio` adds the two workspaces.
   - `PROVENANCE.md` of both providers covers the byte-identical references.
   - The session record.
9. **Commit and push** as one commit; verify the remote SHA through the GitHub API.

## 6. Rollback

Each of steps 1 and 9 is a single commit on top of a pushed base, so rollback is `git revert <sha>` (append-only; no history rewrite).
