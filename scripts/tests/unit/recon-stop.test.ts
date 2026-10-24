// How a run stops a sandboxed client: the command inside the sandbox gets SIGTERM first, so it runs its own shutdown;
// the sandbox is signalled only when the command does not exit within the grace.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  ProcessControl,
  ProcProcessControl,
  sandboxedCommand,
  stopSandboxed,
} from "@accounts-proxy/scripts/recon/sandbox/stop.ts";

/** outer 100 → init 200 → command 300; `exitOn` decides which signal makes the sandbox exit. */
class FakeControl extends ProcessControl {
  readonly sent: [number, NodeJS.Signals][] = [];
  constructor(
    private readonly tree: Record<number, number[]>,
    private readonly exitOn: (pid: number, signal: NodeJS.Signals) => boolean,
    private readonly exit: () => void,
  ) {
    super();
  }
  children(pid: number): readonly number[] {
    return this.tree[pid] ?? [];
  }
  signal(pid: number, signal: NodeJS.Signals): boolean {
    this.sent.push([pid, signal]);
    if (this.exitOn(pid, signal)) setTimeout(this.exit, 1);
    return true;
  }
}

function sandbox(exitOn: (pid: number, signal: NodeJS.Signals) => boolean, tree = { 100: [200], 200: [300] }) {
  let exit!: () => void;
  const exited = new Promise<void>((resolveExit) => {
    exit = resolveExit;
  });
  return { control: new FakeControl(tree, exitOn, () => exit()), running: { pid: 100, exited } };
}

describe("sandboxedCommand", () => {
  test("is the inner bwrap's first child", () => {
    const { control } = sandbox(() => false);
    expect(sandboxedCommand(control, 100)).toBe(300);
  });
  test("is undefined when the namespace has no init or no command", () => {
    expect(sandboxedCommand(sandbox(() => false, { 100: [], 200: [] } as never).control, 100)).toBeUndefined();
    expect(sandboxedCommand(sandbox(() => false, { 100: [200] } as never).control, 100)).toBeUndefined();
  });
});

describe("stopSandboxed", () => {
  test("a client that quits on SIGTERM is never killed and the sandbox gets no signal", async () => {
    const { control, running } = sandbox((pid, signal) => pid === 300 && signal === "SIGTERM");
    const outcome = await stopSandboxed(control, running, 1_000, 1_000);
    expect(control.sent).toEqual([[300, "SIGTERM"]]);
    expect(outcome).toEqual({ signals: [{ target: "command", signal: "SIGTERM" }], graceful: true });
  });

  test("a client that ignores SIGTERM: after the grace the sandbox gets SIGTERM", async () => {
    const { control, running } = sandbox((pid, signal) => pid === 100 && signal === "SIGTERM");
    const outcome = await stopSandboxed(control, running, 20, 1_000);
    expect(control.sent).toEqual([
      [300, "SIGTERM"],
      [100, "SIGTERM"],
    ]);
    expect(outcome.graceful).toBe(false);
  });

  test("a sandbox that ignores SIGTERM gets SIGKILL", async () => {
    const { control, running } = sandbox((pid, signal) => pid === 100 && signal === "SIGKILL");
    const outcome = await stopSandboxed(control, running, 20, 20);
    expect(control.sent.map(([pid, signal]) => `${pid}:${signal}`)).toEqual(["300:SIGTERM", "100:SIGTERM", "100:SIGKILL"]);
    expect(outcome.signals.at(-1)).toEqual({ target: "sandbox", signal: "SIGKILL" });
  });

  test("with no command found the sandbox is stopped directly", async () => {
    const { control, running } = sandbox((pid) => pid === 100, { 100: [200] } as never);
    const outcome = await stopSandboxed(control, running, 1_000, 1_000);
    expect(control.sent).toEqual([[100, "SIGTERM"]]);
    expect(outcome.graceful).toBe(false);
  });
});

describe("ProcProcessControl", () => {
  test("reads a real process's children and signals it; a gone process has none and cannot be signalled", async () => {
    const parent = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
    const control = new ProcProcessControl();
    let kids: readonly number[] = [];
    for (let i = 0; i < 50 && kids.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      kids = control.children(parent.pid!);
    }
    expect(kids.length).toBe(1);
    expect(control.signal(kids[0]!, "SIGTERM")).toBe(true);
    await new Promise<void>((r) => parent.once("exit", () => r()));
    expect(control.children(parent.pid!)).toEqual([]);
    expect(control.signal(parent.pid!, "SIGTERM")).toBe(false);
  });
});
