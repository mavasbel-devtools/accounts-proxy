// Project rename inference-router → accounts-proxy (plan 2026-10-16 amendment R, decisions Q1-B, Q2–Q3).
// Usage:
//   bun scripts/evidence/rename-project.ts --apply   rewrite every live tracked file and `git mv` every live path
//   bun scripts/evidence/rename-project.ts --check   prove the working tree differs from HEAD only by the name map
// Live files get the whole map; generated model data (`builtin-models.ts`) only the product names, because its
// model descriptions name third-party "routers"; historical records keep the old name verbatim (decision Q2):
// dated docs (plans, research, reference, sessions, issues, temp), recorded provider exchanges and vendored sources.
// The check maps the old and the new spelling of every name to one neutral token on both sides (HEAD and the working
// tree) and requires the results to be equal, so a change that is not a pure name substitution fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const SELF = "scripts/evidence/rename-project.ts";
const LEGACY_TEST = "tests/arch/legacy-names.test.ts";

const HISTORICAL = [/^docs\/(plans|research|reference|sessions|issues|temp)\//, /^tests\/fixtures\/captures\//, /\/tests\/reference\/plugin-[0-9a-f]+\//];
const DATA = /\/src\/(domain\/builtin-models|adapters\/outbound\/builtin-model-reference)\.ts$/;
export type Kind = "historical" | "data" | "live";
export const kindOf = (path: string): Kind =>
  path === SELF || path === LEGACY_TEST || HISTORICAL.some((r) => r.test(path)) ? "historical" : DATA.test(path) ? "data" : "live";

// Historical file names that live documents link to; they keep their names (Q2).
const PROTECTED = ["2026-10-06-00-23-inference-router-plan", "llm-router-from-auth-plugins"];
const NOT_ID = "(?<![A-Za-z0-9_-])";
const PRODUCT: [string, string, string][] = [
  ["inference-router", "inference-router", "accounts-proxy"],
  ["INFERENCE_ROUTER", "INFERENCE_ROUTER", "ACCOUNTS_PROXY"],
  ["Inference Router", "Inference Router", "Accounts Proxy"],
  ["ir-<provider>", `${NOT_ID}ir-(?=[a-z<$])`, "ap-"],
  ["rtr_ session prefix", `${NOT_ID}rtr_`, "ap_"],
];
const GENERIC: [string, string, string][] = [
  ["routers", "(?<![Oo]pen)routers", "proxies"],
  ["Routers", "(?<![Oo]pen)Routers", "Proxies"],
  ["router", "(?<![Oo]pen)router", "proxy"],
  ["Router", "(?<![Oo]pen)Router", "Proxy"],
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rewriter(rules: [string, string, string][]) {
  const all: [string, string, string | null][] = [...PROTECTED.map((p): [string, string, null] => [`protected ${p}`, escape(p), null]), ...rules];
  const pattern = new RegExp(all.map(([, re]) => `(${re})`).join("|"), "g");
  return (text: string, counts: Map<string, number>) =>
    text.replace(pattern, (match, ...groups) => {
      const index = groups.findIndex((g, i) => i < all.length && g !== undefined);
      const [label, , replacement] = all[index]!;
      if (replacement === null) return match;
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return replacement;
    });
}
const forLive = rewriter([...PRODUCT, ...GENERIC]);
const forData = rewriter(PRODUCT);
export const rename = (path: string, text: string, counts = new Map<string, number>()): string =>
  kindOf(path) === "live" ? forLive(text, counts) : kindOf(path) === "data" ? forData(text, counts) : text;

// Paths: every non-historical path takes the whole map (a data file's folder is a live folder).
export const movedPath = (path: string): string => (kindOf(path) === "historical" ? path : forLive(path, new Map()));

// Neutral form used by --check: both spellings of every name become one token.
const NEUTRAL: [RegExp, string][] = [
  ...PROTECTED.map((p): [RegExp, string] => [new RegExp(escape(p), "g"), `#KEEP:${p}#`]),
  [/inference-router|accounts-proxy/g, "#NAME#"],
  [/INFERENCE_ROUTER|ACCOUNTS_PROXY/g, "#ENV#"],
  [/Inference Router|Accounts Proxy/g, "#TITLE#"],
  [new RegExp(`${NOT_ID}(?:ir|ap)-(?=[a-z<$])`, "g"), "#ID#-"],
  [new RegExp(`${NOT_ID}(?:rtr|ap)_`, "g"), "#SESSION#_"],
  [/(?<![Oo]pen)(?:routers|proxies)/g, "#rs#"],
  [/(?<![Oo]pen)(?:Routers|Proxies)/g, "#Rs#"],
  [/(?<![Oo]pen)(?:router|proxy)/g, "#r#"],
  [/(?<![Oo]pen)(?:Router|Proxy)/g, "#R#"],
];
const neutral = (text: string) => NEUTRAL.reduce((t, [re, to]) => t.replace(re, to), text);

const mode = process.argv[2];
if (mode === "--apply") {
  const counts = new Map<string, number>();
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  let changed = 0;
  let moved = 0;
  for (const path of files) {
    const before = readFileSync(join(root, path), "utf8");
    const after = rename(path, before, counts);
    if (after !== before) {
      writeFileSync(join(root, path), after);
      changed++;
    }
    const target = movedPath(path);
    if (target !== path) {
      mkdirSync(dirname(join(root, target)), { recursive: true });
      git("mv", path, target);
      console.log(`moved ${path} -> ${target}`);
      moved++;
    }
  }
  for (const [label, n] of [...counts].sort()) console.log(`${String(n).padStart(6)}  ${label}`);
  console.log(`${changed} files rewritten, ${moved} paths moved`);
} else if (mode === "--check") {
  git("add", "-A", "--intent-to-add", ".");
  const status = git("diff", "HEAD", "--name-status", "--no-renames", "-z").split("\0").filter(Boolean);
  const deleted = new Set<string>();
  const added = new Set<string>();
  const pairs: [string, string][] = [];
  for (let i = 0; i < status.length; i += 2) {
    const [code, path] = [status[i]!, status[i + 1]!];
    if (code === "D") deleted.add(path);
    else if (code === "A") added.add(path);
    else pairs.push([path, path]);
  }
  // A moved path must be exactly the name map of its old path; anything else added or deleted is not a rename.
  for (const path of deleted) {
    const target = movedPath(path);
    if (added.delete(target)) pairs.push([path, target]);
    else pairs.push([path, path]);
  }
  for (const path of added) if (path !== SELF && path !== LEGACY_TEST) pairs.push([path, path]);
  let failures = 0;
  for (const [from, to] of pairs) {
    if (from === SELF || to === SELF || to === LEGACY_TEST) continue;
    let before: string;
    let after: string;
    try {
      before = git("show", `HEAD:${from}`);
      after = readFileSync(join(root, to), "utf8");
    } catch {
      console.error(`NOT A RENAME ${from} -> ${to} (added or deleted)`);
      failures++;
      continue;
    }
    if (neutral(from) !== neutral(to) || neutral(before) !== neutral(after)) {
      console.error(`NOT MECHANICAL ${from} -> ${to}`);
      failures++;
    } else if (kindOf(from) === "historical" && (before !== after || from !== to)) {
      console.error(`HISTORICAL CHANGED ${from}`);
      failures++;
    }
  }
  console.log(`${pairs.length} changed paths checked, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
} else if (import.meta.main) {
  console.error("usage: rename-project.ts --apply | --check");
  process.exit(2);
}
