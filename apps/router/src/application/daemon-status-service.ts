// `status`: GET <url>/health (the one open route) with a short deadline; anything but a well-formed health answer
// means "not running", with the reason.
import { UpstreamUnreachableError } from "@inference-router/core/domain/errors.ts";
import { isProviderId, type ProviderId } from "@inference-router/core/domain/models.ts";
import { errorMessage } from "@inference-router/core/domain/services/error-message.ts";
import { readAll } from "@inference-router/core/domain/wire.ts";
import { DaemonStatusPort, type DaemonStatus } from "@inference-router/core/ports/inbound/daemon.ts";
import type { HttpTransportPort } from "@inference-router/core/ports/outbound/transport.ts";

export const STATUS_TIMEOUT_MS = 2_000;

export class DaemonStatusService extends DaemonStatusPort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly url: string,
  ) {
    super();
  }

  async status(): Promise<DaemonStatus> {
    const url = this.url;
    try {
      const res = await this.transport.send({ method: "GET", url: `${url}/health`, headers: {}, timeoutMs: STATUS_TIMEOUT_MS });
      const text = await readAll(res.body);
      if (res.status !== 200) return { running: false, url, reason: `GET /health answered HTTP ${res.status}` };
      const parsed = JSON.parse(text) as { status?: unknown; providers?: unknown };
      if (parsed.status !== "ok" || !Array.isArray(parsed.providers)) return { running: false, url, reason: "GET /health is not an inference-router health answer" };
      return { running: true, url, providers: parsed.providers.filter((p): p is ProviderId => typeof p === "string" && isProviderId(p)) };
    } catch (error) {
      // The daemon is not an upstream: a refused connection reads "nothing is listening" (live L0, 2026-10-13).
      return { running: false, url, reason: error instanceof UpstreamUnreachableError ? `nothing is listening: ${error.detail}` : errorMessage(error) };
    }
  }
}
