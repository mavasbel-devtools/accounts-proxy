// Runtime law for apps/pi-extension (architecture design §5): the extension runs inside pi's Node.js
// process, so its sources use only node:* modules and Node.js globals: no Bun global, no bun: import,
// no import.meta.dir. The positive test runs over the real tree; the negative test proves the checker
// reports each marker on a synthetic string (gate self-test).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dir, "..", "..", "apps", "pi-extension", "src");

const FORBIDDEN = ["Bun.", 'from "bun', "import.meta.dir"] as const;

export function runtimeProblems(source: string): string[] {
  return FORBIDDEN.filter((marker) => source.includes(marker));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("pi-extension runtime law", () => {
  test("every source file avoids Bun-only APIs", () => {
    expect(existsSync(srcDir)).toBe(true);
    for (const file of walk(srcDir)) {
      expect(runtimeProblems(readFileSync(file, "utf8"))).toEqual([]);
    }
  });

  test("the checker reports each forbidden marker (gate self-test)", () => {
    expect(runtimeProblems("const home = Bun.env.HOME;")).toEqual(["Bun."]);
    expect(runtimeProblems('import { test } from "bun:test";')).toEqual(['from "bun']);
    expect(runtimeProblems("const dir = import.meta.dir;")).toEqual(["import.meta.dir"]);
    expect(runtimeProblems("const clean = process.env.HOME;")).toEqual([]);
  });
});
