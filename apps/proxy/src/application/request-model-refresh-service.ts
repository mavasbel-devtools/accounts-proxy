// `models --refresh` (plan 2026-10-26 R2): the daemon keeps the model lists in its memory, so a refresh is asked of the
// running daemon (POST /proxy/v1/models/refresh with the proxy token). When nothing listens on the daemon's address,
// this process refreshes the lists itself, which rewrites the stored copies a daemon reads when it starts.
import { UpstreamUnreachableError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedCatalog } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { readAll } from "@accounts-proxy/core/domain/wire.ts";
import type { AccessPort } from "@accounts-proxy/core/ports/inbound/access.ts";
import { MODEL_REFRESH_PATH, RequestModelRefreshPort, type RefreshModelsPort, type RefreshOutcome } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { HttpTransportPort } from "@accounts-proxy/core/ports/outbound/transport.ts";

/**
 * Bound of the daemon's refresh: the sum of the bounded reads it may make in turn — the reference catalog (30 s), Claude
 * (3 parallel start-up reads, the model selector and up to 10 pages, 3 s each: 36 s) and four gateway lists (30 s each)
 * — is 186 s; 300 s leaves the margin.
 */
export const REFRESH_TIMEOUT_MS = 300_000;

export class DaemonRefreshError extends Error {
  constructor(url: string, status: number, detail: string) {
    super(`the daemon at ${url} answered the refresh with HTTP ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "DaemonRefreshError";
  }
}

export class RequestModelRefreshService extends RequestModelRefreshPort {
  constructor(
    private readonly transport: HttpTransportPort,
    private readonly access: AccessPort,
    private readonly url: string,
    private readonly local: RefreshModelsPort,
  ) {
    super();
  }

  async request(provider?: ProviderId): Promise<RefreshOutcome> {
    const target = `${this.url}${MODEL_REFRESH_PATH}${provider === undefined ? "" : `?provider=${provider}`}`;
    let response;
    try {
      response = await this.transport.send({ method: "POST", url: target, headers: { authorization: `Bearer ${await this.access.token()}` }, timeoutMs: REFRESH_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof UpstreamUnreachableError)) throw error;
      return { by: "this process", url: this.url, catalogs: await this.local.refreshModels(provider) };
    }
    const text = await readAll(response.body);
    const parsed = parseJson(text);
    if (response.status !== 200) throw new DaemonRefreshError(this.url, response.status, errorText(parsed));
    if (!isJsonObject(parsed) || !Array.isArray(parsed["catalogs"])) throw new DaemonRefreshError(this.url, response.status, "the answer has no catalogs");
    return { by: "daemon", url: this.url, catalogs: parsed["catalogs"] as unknown as readonly DetailedCatalog[] };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The message of the proxy's plain error answer `{error: {code, message}}`, else nothing. */
function errorText(parsed: unknown): string {
  const error = isJsonObject(parsed) ? parsed["error"] : undefined;
  return isJsonObject(error) && typeof error["message"] === "string" ? error["message"] : "";
}
