// The daemon's console output (plan 2026-10-27 C1): silent until started, then every log line and every exchange
// record (redacted as the file writes it) on its own line; the inner logger and sink still get everything.
import { describe, expect, test } from "bun:test";
import { DaemonConsolePort } from "@accounts-proxy/core/ports/inbound/daemon.ts";
import type { ExchangeEntry } from "@accounts-proxy/core/domain/exchange-log.ts";
import { ExchangeSinkPort } from "@accounts-proxy/core/ports/outbound/exchange-log.ts";
import { ClockPort, ConsoleMirrorPort, HashPort, LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { MirroredExchangeSink, MirroredLogger, TerminalMirror } from "@accounts-proxy/proxy/adapters/outbound/console-mirror.ts";
import { DaemonConsoleService } from "@accounts-proxy/proxy/application/daemon-console-service.ts";

class FixedClock extends ClockPort {
  now() {
    return Date.UTC(2026, 9, 27, 20, 40);
  }
}
class ZeroHash extends HashPort {
  sha256() {
    return new Uint8Array(32);
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
class Entries extends ExchangeSinkPort {
  readonly entries: ExchangeEntry[] = [];
  write(entry: ExchangeEntry) {
    this.entries.push(entry);
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

  test("MirroredExchangeSink: the inner sink gets the entry as given, the console the redacted record line", () => {
    const out: string[] = [];
    const mirror = new TerminalMirror((t) => out.push(t));
    mirror.start();
    const inner = new Entries();
    const sink = new MirroredExchangeSink(inner, mirror, new FixedClock(), new ZeroHash(), 7);
    const entry: ExchangeEntry = { kind: "upstream-request", id: "u", headers: [["authorization", "Bearer secret"]] };
    sink.write(entry);
    expect(inner.entries).toEqual([entry]);
    expect(out).toEqual([
      `${JSON.stringify({ schema: "accounts-proxy-exchange/1", at: "2026-10-27T20:40:00.000Z", pid: 7, kind: "upstream-request", id: "u", headers: [["authorization", "[redacted sha256:000000000000 len:13]"]] })}\n`,
    ]);
  });
});
