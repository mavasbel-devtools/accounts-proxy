import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidRequestError } from "@inference-router/core/domain/errors.ts";
import { makeTemporary, removeTemporary } from "@inference-router/test-support/temporary.ts";
import { OpencodeAuthFile, opencodeDataDir } from "@inference-router/router/adapters/outbound/opencode-auth-file.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeTemporary(dir);
  dir = undefined;
});

describe("OpencodeAuthFile (rule Z22, decision K5)", () => {
  test("OpenCode's data directory: XDG_DATA_HOME (an empty value ignored), else ~/.local/share", () => {
    expect(opencodeDataDir({ XDG_DATA_HOME: "/x" })).toBe("/x/opencode");
    expect(opencodeDataDir({ XDG_DATA_HOME: "" })).toBe(join(homedir(), ".local", "share", "opencode"));
    expect(opencodeDataDir({})).toBe(join(homedir(), ".local", "share", "opencode"));
  });

  test("reads an API key; refuses a sign-in, a missing entry, a non-JSON or missing file; never writes", async () => {
    dir = makeTemporary("opencode-auth");
    const text = JSON.stringify({ openrouter: { type: "api", key: "sk-or-1" }, openai: { type: "oauth", refresh: "r", access: "a", expires: 1 }, empty: { type: "api", key: "" } });
    writeFileSync(join(dir, "auth.json"), text);
    chmodSync(join(dir, "auth.json"), 0o400);
    const file = new OpencodeAuthFile(dir);
    expect(file.tool).toBe("opencode");
    expect(await file.apiKey("openrouter")).toBe("sk-or-1");
    await expect(file.apiKey("openai")).rejects.toThrow("OpenCode stores a sign-in for openai, not an API key; only API keys are imported (sign in with `inference-router login openai`)");
    await expect(file.apiKey("claude")).rejects.toThrow(`OpenCode stores no API key for claude in ${join(dir, "auth.json")}`);
    await expect(file.apiKey("empty" as never)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe(text);
    chmodSync(join(dir, "auth.json"), 0o600);
    writeFileSync(join(dir, "auth.json"), "[1]");
    await expect(file.apiKey("openrouter")).rejects.toThrow("OpenCode stores no API key for openrouter");
    writeFileSync(join(dir, "auth.json"), "{");
    await expect(file.apiKey("openrouter")).rejects.toThrow(`OpenCode's credential file ${join(dir, "auth.json")} is not JSON`);
    const missing = join(dir, "none");
    mkdirSync(missing);
    await expect(new OpencodeAuthFile(missing).apiKey("openrouter")).rejects.toThrow(`cannot read OpenCode's credential file ${join(missing, "auth.json")}: ENOENT`);
  });
});
