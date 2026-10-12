// Risk R1, option B (user decision 2026-10-11): code that no P4 route or command can reach is DEFERRED from the
// e2e-alone gate until the phase that wires it — never from the unit+component or merged gates. Every deferral names
// its phase and reason, is printed on every e2e gate run, and fails the gate when it is stale (the file or function no
// longer exists, the name is ambiguous, or the e2e tier already covers it fully, so it must leave the list). The list
// must be empty when P5 ends (P5 wires the translated cells that call all of it).
import { createCoverageMap, type CoverageMap, type FileCoverageData, type Range } from "istanbul-lib-coverage";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type Deferral = {
  /** Repository-relative source path. */
  readonly file: string;
  /** Function or method names to defer (each must name exactly one function in the file). */
  readonly functions?: readonly string[];
  /** Branches to defer, each named by the exact (trimmed) source line it starts on, which must hold exactly one; the
   * statements on that line no e2e process ran (the deferred arm, e.g. an if's `continue`) are deferred with it. */
  readonly branches?: readonly string[];
  readonly phase: "P5";
  readonly reason: string;
};

const TRANSLATED = "only the translated cells (P5) call it; no P4 route or command reaches it";

export const E2E_DEFERRED: readonly Deferral[] = [
  { file: "packages/core/src/domain/services/feature-support.ts", phase: "P5", reason: `capability matrix of the translated cells: ${TRANSLATED}` },
  { file: "packages/core/src/domain/services/usage.ts", phase: "P5", reason: `canonical usage merging: ${TRANSLATED}` },
  { file: "packages/core/src/domain/services/event-stream.ts", functions: ["end", "encode"], phase: "P5", reason: `SSE encoding and truncation report of the dialect encoders: ${TRANSLATED}` },
  { file: "packages/provider-antigravity/src/domain/generate.ts", phase: "P5", reason: `ChatRequest → generateContent codec: ${TRANSLATED}` },
  { file: "packages/provider-antigravity/src/adapters/outbound/antigravity-chat.ts", phase: "P5", reason: `chat over the runner: ${TRANSLATED}` },
  { file: "packages/provider-antigravity/src/domain/catalog.ts", functions: ["wireDefaultsFor"], phase: "P5", reason: `per-model defaults of the translated requests: ${TRANSLATED}` },
  { file: "packages/provider-antigravity/src/adapters/outbound/antigravity-provider.ts", functions: ["capabilities", "stream", "countTokens"], phase: "P5", reason: `canonical ProviderPort methods: ${TRANSLATED}` },
  { file: "packages/provider-claude/src/adapters/outbound/claude-subscription-provider.ts", functions: ["capabilities", "stream", "countTokens"], phase: "P5", reason: `canonical ProviderPort methods: ${TRANSLATED}` },
  { file: "packages/dialect-anthropic/src/adapters/inbound/anthropic-codec.ts", branches: ['headers: { ...JSON_HEADERS, ...(error.retryAfterSeconds !== undefined ? { "retry-after": String(error.retryAfterSeconds) } : {}) },'], phase: "P5", reason: `a router error with retry-after comes only from antigravity, which this dialect reaches only through a translated cell: ${TRANSLATED}` },
  { file: "packages/dialect-openai/src/adapters/inbound/openai-codec.ts", branches: ['headers: { ...JSON_HEADERS, ...(error.retryAfterSeconds !== undefined ? { "retry-after": String(error.retryAfterSeconds) } : {}) },'], phase: "P5", reason: `a router error with retry-after comes only from antigravity, which this dialect reaches only through a translated cell: ${TRANSLATED}` },
  { file: "packages/provider-antigravity/src/adapters/outbound/antigravity-runner.ts", branches: ["if (out === undefined) continue;"], phase: "P5", reason: `only the chat mapper skips content-free envelopes (the native mapper forwards every response): ${TRANSLATED}` },
];

export type DeferralResult = { readonly map: CoverageMap; readonly exemptFiles: ReadonlySet<string>; readonly notes: readonly string[]; readonly problems: readonly string[] };

/** istanbul names class methods "(anonymous_N)"; the method name is read from the source at the declaration. */
function nameOf(fn: { name: string; decl: Range }, lines: readonly string[]): string {
  if (!fn.name.startsWith("(anonymous_")) return fn.name;
  const declared = /^(?:async\s+)?\*?\s*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(<]/.exec(lines[fn.decl.start.line - 1]!.slice(fn.decl.start.column));
  return declared?.[1] ?? fn.name;
}

const inside = (outer: Range, inner: Range): boolean => {
  const after = inner.start.line > outer.start.line || (inner.start.line === outer.start.line && inner.start.column >= outer.start.column);
  const endLine = inner.end.line < outer.end.line;
  const sameEnd = inner.end.line === outer.end.line && (outer.end.column === null || (inner.end.column !== null && inner.end.column <= outer.end.column));
  return after && (endLine || sameEnd);
};

function fullyCovered(data: FileCoverageData, keep: (range: Range) => boolean): boolean {
  const statements = Object.entries(data.statementMap).filter(([, r]) => keep(r));
  const functions = Object.entries(data.fnMap).filter(([, f]) => keep(f.loc));
  const branches = Object.entries(data.branchMap).filter(([, b]) => keep(b.loc));
  return statements.every(([id]) => data.s[id]! > 0) && functions.every(([id]) => data.f[id]! > 0) && branches.every(([id]) => data.b[id]!.every((n) => n > 0));
}

/** Removes the deferred code from an e2e coverage map; reports what was deferred and every stale entry. */
export function applyDeferrals(map: CoverageMap, deferrals: readonly Deferral[], root: string): DeferralResult {
  const data = map.toJSON();
  const byPath = new Map(Object.keys(data).map((path) => [relative(root, path).replaceAll("\\", "/"), path]));
  const exemptFiles = new Set<string>();
  const notes: string[] = [];
  const problems: string[] = [];
  for (const deferral of deferrals) {
    const absolute = byPath.get(deferral.file);
    const parts = [...(deferral.functions ?? []), ...(deferral.branches ?? []).map((b) => `branch \`${b}\``)];
    const label = `${deferral.file}${parts.length > 0 ? ` [${parts.join(", ")}]` : ""} (${deferral.phase}: ${deferral.reason})`;
    if (parts.length === 0) {
      if (absolute !== undefined && fullyCovered(data[absolute]!, () => true)) {
        problems.push(`stale deferral: ${deferral.file} is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts`);
        continue;
      }
      if (absolute !== undefined) delete data[absolute];
      exemptFiles.add(join(root, deferral.file));
      notes.push(`deferred file ${label}`);
      continue;
    }
    if (absolute === undefined) {
      problems.push(`stale deferral: ${deferral.file} was not loaded by any e2e process; defer the whole file or remove the entry`);
      continue;
    }
    const file = data[absolute]!;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (const text of deferral.branches ?? []) {
      const matches = Object.entries(file.branchMap).filter(([, b]) => lines[b.loc.start.line - 1]!.trim() === text);
      if (matches.length !== 1) {
        problems.push(`stale deferral: ${deferral.file} has ${matches.length} branches on a line \`${text}\` (expected exactly one)`);
        continue;
      }
      const [id] = matches[0]!;
      if (file.b[id]!.every((n) => n > 0)) {
        problems.push(`stale deferral: ${deferral.file} branch \`${text}\` is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts`);
        continue;
      }
      const line = file.branchMap[id]!.loc.start.line;
      delete file.branchMap[id];
      delete file.b[id];
      for (const [statement, loc] of Object.entries(file.statementMap)) {
        if (loc.start.line === line && file.s[statement] === 0) {
          delete file.statementMap[statement];
          delete file.s[statement];
        }
      }
    }
    for (const name of deferral.functions ?? []) {
      const matches = Object.entries(file.fnMap).filter(([, f]) => nameOf(f, lines) === name);
      if (matches.length !== 1) {
        problems.push(`stale deferral: ${deferral.file} has ${matches.length} functions named ${name} (expected exactly one)`);
        continue;
      }
      const [id, fn] = matches[0]!;
      if (fullyCovered(file, (r) => inside(fn.loc, r))) {
        problems.push(`stale deferral: ${deferral.file} ${name} is fully covered by e2e; remove it from scripts/gate/e2e-deferred.ts`);
        continue;
      }
      for (const [sid, range] of Object.entries(file.statementMap)) {
        if (!inside(fn.loc, range)) continue;
        delete file.statementMap[sid];
        delete file.s[sid];
      }
      for (const [bid, branch] of Object.entries(file.branchMap)) {
        if (!inside(fn.loc, branch.loc)) continue;
        delete file.branchMap[bid];
        delete file.b[bid];
      }
      // The function itself and every function nested in it (callbacks, closures).
      for (const [fid, other] of Object.entries(file.fnMap)) {
        if (fid !== id && !inside(fn.loc, other.loc)) continue;
        delete file.fnMap[fid];
        delete file.f[fid];
      }
    }
    notes.push(`deferred ${label}`);
  }
  return { map: createCoverageMap(data), exemptFiles, notes, problems };
}
