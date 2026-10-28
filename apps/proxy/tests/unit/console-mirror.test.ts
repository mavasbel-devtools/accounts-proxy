// The daemon's console output (plan 2026-10-27 C1, L5 of plan 2026-10-27-23-29): silent until started, then every log
// line on its own line; the inner logger still gets everything. Usage records never reach the console.
import { describe, expect, test } from "bun:test";
import { DaemonConsolePort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import { ClockPort, ConsoleMirrorPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { MirroredLogger, TerminalMirror } from "@accounts-proxy/proxy/adapters/outbound/console-mirror.ts";
import { DaemonConsoleService } from "@accounts-proxy/proxy/application/daemon-console-service.ts";

class FixedClock extends ClockPort {
  now() {
    return Date.UTC(2026, 9, 27, 20, 40);
  }
}
class Lines extends LoggerPort {
  readonly lines: string[] = [];
  info(m: string) {
    this.lines.push(`info ${m}`);
  }
  warn(m: string) {
    this.lines.push(`warn ${m}`);
  }
  error(m: string) {
    this.lines.push(`error ${m}`);
  }
}

describe("console mirror (plan 2026-10-27 C1)", () => {
  test("TerminalMirror drops lines until started, then writes each with a newline; a failing write is swallowed", () => {
    const out: string[] = [];
    const mirror = new TerminalMirror((t) => out.push(t));
    expect(mirror).toBeInstanceOf(ConsoleMirrorPort);
    mirror.line("before");
    mirror.start();
    mirror.line("after");
    expect(out).toEqual(["after\n"]);
    const broken = new TerminalMirror(() => {
      throw new Error("EPIPE");
    });
    broken.start();
    expect(() => broken.line("x")).not.toThrow();
  });

  test("DaemonConsoleService starts the mirror", () => {
    const out: string[] = [];
    const mirror = new TerminalMirror((t) => out.push(t));
    const service = new DaemonConsoleService(mirror);
    expect(service).toBeInstanceOf(DaemonConsolePort);
    service.attach();
    mirror.line("x");
    expect(out).toEqual(["x\n"]);
  });

  test("MirroredLogger: every level to the inner logger and, as proxy.log has it, to the console", () => {
    const out: string[] = [];
    const mirror = new TerminalMirror((t) => out.push(t));
    mirror.start();
    const inner = new Lines();
    const logger = new MirroredLogger(inner, mirror, new FixedClock());
    logger.info("i");
    logger.warn("w");
    const cause = new Error("boom");
    logger.error("e", cause);
    expect(inner.lines).toEqual(["info i", "warn w", "error e"]);
    expect(out).toEqual(["2026-10-27T20:40:00.000Z INFO i\n", "2026-10-27T20:40:00.000Z WARN w\n", `2026-10-27T20:40:00.000Z ERROR e :: ${cause.stack}\n`]);
  });
});
