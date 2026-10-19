// Documentation lint (part of verify):
//  - docs/{plans,research,issues,reference,temp}/*.md follow YYYY-MM-DD-HH-MM-<kebab-name>.md (AGENTS.md naming law);
//  - docs/sessions/*.md are named <session-id>.md (ses_<alnum>);
//  - every relative Markdown link in README.md, AGENTS.md and docs/**/*.md resolves to an existing file, and its
//    `#fragment` (also a same-file `#fragment`) to a heading of the target Markdown file (GitHub's heading ids);
//  - every *.drawio file is an <mxfile> document.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repositoryRoot } from "@accounts-proxy/scripts/gate/instrument.ts";

const DATED = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SESSION = /^ses_[A-Za-z0-9]+\.md$/;
const problems: string[] = [];
const docs = join(repositoryRoot, "docs");

for (const folder of ["plans", "research", "issues", "reference", "temp"]) {
  const dir = join(docs, folder);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".md") && !DATED.test(entry)) problems.push(`docs/${folder}/${entry}: name violates YYYY-MM-DD-HH-MM-name.md`);
  }
}
const sessions = join(docs, "sessions");
if (existsSync(sessions)) {
  for (const entry of readdirSync(sessions)) {
    if (entry.endsWith(".md") && !SESSION.test(entry)) problems.push(`docs/sessions/${entry}: name must be <session-id>.md`);
  }
}

function walk(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "specs" || entry === "temp") return [];
    return statSync(full).isDirectory() ? walk(full, suffix) : full.endsWith(suffix) ? [full] : [];
  });
}

/** GitHub's heading ids (github-slugger): lower case, punctuation removed, spaces → `-`, repeats get `-1`, `-2`, …. */
function headingIds(markdownText: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of markdownText.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const text = heading[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

const markdown = [join(repositoryRoot, "README.md"), join(repositoryRoot, "AGENTS.md"), ...walk(docs, ".md")].filter(existsSync);
const LINK = /\]\(([^)\s]+)\)/g;
for (const file of markdown) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(LINK)) {
    const target = match[1]!;
    if (/^[a-z]+:/i.test(target)) continue;
    const [pathPart, fragment] = target.split("#") as [string, string | undefined];
    const path = pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
    if (!existsSync(path)) {
      problems.push(`${relative(repositoryRoot, file)}: broken link ${target}`);
      continue;
    }
    if (fragment !== undefined && path.endsWith(".md") && !headingIds(readFileSync(path, "utf8")).has(decodeURIComponent(fragment))) {
      problems.push(`${relative(repositoryRoot, file)}: link ${target} names no heading of ${relative(repositoryRoot, path)}`);
    }
  }
}

for (const file of walk(repositoryRoot, ".drawio")) {
  const text = readFileSync(file, "utf8").trimStart();
  if (!text.startsWith("<mxfile") || !text.trimEnd().endsWith("</mxfile>")) problems.push(`${relative(repositoryRoot, file)}: not an <mxfile> document`);
}

for (const problem of problems) console.error(`DOCS LINT FAIL — ${problem}`);
console.log(problems.length === 0 ? `docs lint PASS (${markdown.length} markdown files)` : `docs lint: ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
