// The usage log as spend (plan 2026-11-06-15-21, stage 3): one `client-response` record per completed exchange, the
// upstream's own charge in `usage.raw.cost`, and the model and provider in the first streamed chunk.
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SpendEntry, SpendWindow } from "@accounts-proxy/core/domain/spend-summary.ts";
import { SpendLogPort, type SpendLogRead } from "@accounts-proxy/core/ports/outbound/spend-log.ts";
import { LOG_FILE, USAGE_LOG } from "@accounts-proxy/proxy/adapters/outbound/log-files.ts";

/** The date a usage log file belongs to, from its name (`<date>-<pid>-usage.<n>.jsonl`). */
const dateOf = (name: string): string | undefined => {
  const match = LOG_FILE.exec(name);
  return match !== null && match[3] === USAGE_LOG.name ? match[1] : undefined;
};

type ClientResponse = {
  readonly kind?: string;
  readonly at?: string;
  readonly status?: number;
  readonly usage?: {
    readonly raw?: { readonly cost?: number };
    readonly tokens?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number };
  };
  readonly body?: { readonly text?: string };
};

const firstChunkFields = (text: string | undefined): { model?: string; provider?: string } => {
  if (text === undefined) return {};
  const head = text.slice(0, 4000);
  const model = /"model"\s*:\s*"([^"]+)"/.exec(head)?.[1];
  const provider = /"provider"\s*:\s*"([^"]+)"/.exec(head)?.[1];
  return { ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }) };
};

/** The entry a record carries, or `undefined` when it carries none: a refused exchange is not malformed. */
const entryOf = (record: ClientResponse): SpendEntry | undefined => {
  if (record.status !== 200) return undefined;
  const cost = record.usage?.raw?.cost;
  const at = record.at === undefined ? Number.NaN : Date.parse(record.at);
  const tokens = record.usage?.tokens;
  if (typeof cost !== "number" || Number.isNaN(at) || tokens === undefined) return undefined;
  const fields = firstChunkFields(record.body?.text);
  return {
    at,
    provider: fields.provider ?? "unknown",
    model: fields.model ?? "unknown",
    cost,
    promptTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cachedTokens: tokens.cacheRead ?? 0,
  };
};

export class SpendLogReader extends SpendLogPort {
  constructor(private readonly directory: string) {
    super();
  }

  async read(window: SpendWindow): Promise<SpendLogRead> {
    if (!existsSync(this.directory)) return { entries: [], malformed: 0, covered: undefined };
    const entries: SpendEntry[] = [];
    const dates = new Set<string>();
    let malformed = 0;
    for (const name of readdirSync(this.directory).sort()) {
      const date = dateOf(name);
      if (date === undefined) continue;
      dates.add(date);
      const fileFrom = Date.parse(`${date}T00:00:00`);
      const fileUntil = fileFrom + 86_400_000;
      const inWindow = fileFrom < window.until && fileUntil > window.from;
      const lines = createInterface({ input: createReadStream(join(this.directory, name)), crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let record: ClientResponse;
        try {
          record = JSON.parse(line) as ClientResponse;
        } catch {
          if (inWindow) malformed += 1;
          continue;
        }
        if (record.kind !== "client-response") continue;
        const entry = entryOf(record);
        if (entry === undefined) {
          if (record.status === 200 && inWindow) malformed += 1;
          continue;
        }
        if (entry.at >= window.from && entry.at < window.until) entries.push(entry);
      }
    }
    const ordered = [...dates].sort();
    const covered =
      ordered.length === 0
        ? undefined
        : { from: Date.parse(`${ordered[0]}T00:00:00`), until: Date.parse(`${ordered[ordered.length - 1]}T00:00:00`) + 86_400_000 };
    return { entries, malformed, covered };
  }
}
