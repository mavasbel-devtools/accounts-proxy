// Failures the HTTP adapters answered themselves go to the router log (the client only sees a fixed text).
import { ErrorReporterPort } from "@inference-router/core/ports/inbound/diagnostics.ts";
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";

export class LoggingErrorReporter extends ErrorReporterPort {
  constructor(private readonly logger: LoggerPort) {
    super();
  }

  report(context: string, error: unknown): void {
    this.logger.error(context, error);
  }
}
