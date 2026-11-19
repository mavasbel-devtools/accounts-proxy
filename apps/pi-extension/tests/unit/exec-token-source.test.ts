// Unit tests for ExecTokenSource (uc-pi-4): injected execFile, no I/O.
import { describe, expect, test } from "bun:test";
import type { ExecFileFn } from "@accounts-proxy/pi-extension/adapters/outbound/exec-token-source.ts";
import { ExecTokenSource } from "@accounts-proxy/pi-extension/adapters/outbound/exec-token-source.ts";

function setup(run: ExecFileFn) {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const execFileFn: ExecFileFn = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    return run(file, args, options);
  };
  return { source: new ExecTokenSource(execFileFn), calls };
}

describe("ExecTokenSource", () => {
  test("runs the command with a 10 s timeout and returns the trimmed stdout [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=positive]", async () => {
    const { source, calls } = setup(async () => ({ stdout: "  secret-token\n" }));
    await expect(source.token(["token", "--print"])).resolves.toBe("secret-token");
    expect(calls).toEqual([{ file: "token", args: ["--print"], timeout: 10000 }]);
  });

  test("empty output throws [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { source } = setup(async () => ({ stdout: "  \n" }));
    await expect(source.token(["token"])).rejects.toThrow("token command printed nothing");
  });

  test("a command failure rejects [feature=pi-extension use-case=uc-pi-4 tier=unit polarity=negative]", async () => {
    const { source } = setup(async () => {
      throw new Error("command failed with exit code 1");
    });
    await expect(source.token(["false"])).rejects.toThrow("command failed with exit code 1");
  });
});
