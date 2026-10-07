import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStrictlyInsideTemporary, makeTemporary, removeTemporary, temporaryRoot } from "@inference-router/test-support/temporary.ts";

describe("removeTemporary guard", () => {
  test("deletes a directory created by makeTemporary", () => {
    const dir = makeTemporary("guard");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "file.txt"), "x");
    removeTemporary(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test.each([["", "empty"], ["   ", "blank"], ["relative/path", "relative"], [".", "cwd"]])(
    "refuses %p (%s)",
    (path) => {
      expect(() => removeTemporary(path)).toThrow(/refusing to delete/);
    },
  );

  test("refuses undefined (a beforeAll that threw before assigning)", () => {
    expect(() => removeTemporary(undefined)).toThrow(/refusing to delete/);
  });

  test("refuses the temporary root itself and anything outside it", () => {
    expect(() => removeTemporary(temporaryRoot())).toThrow(/refusing to delete/);
    expect(() => removeTemporary(tmpdir())).toThrow(/refusing to delete/);
    expect(() => removeTemporary(process.cwd())).toThrow(/refusing to delete/);
    expect(() => removeTemporary(join(temporaryRoot(), "..", "escape"))).toThrow(/refusing to delete/);
  });

  test("isStrictlyInsideTemporary classifies paths", () => {
    expect(isStrictlyInsideTemporary(join(temporaryRoot(), "a", "b"))).toBe(true);
    expect(isStrictlyInsideTemporary(temporaryRoot())).toBe(false);
    expect(isStrictlyInsideTemporary(123 as unknown as string)).toBe(false);
  });

  test("makeTemporary rejects unsafe prefixes", () => {
    expect(() => makeTemporary("../x")).toThrow(/invalid temporary prefix/);
  });
});
