// `login <provider> --from-opencode` (plan P4.6 amendment A, K5): OpenCode's stored API key for one provider, read once
// from `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` (rule Z22). The file is only read, never written; a stored
// sign-in (`oauth`) is refused, since sharing a rotating token would break OpenCode's own session.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidRequestError } from "@accounts-proxy/core/domain/errors.ts";
import { isJsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { ForeignKeySourcePort } from "@accounts-proxy/core/ports/outbound/api-key.ts";

/** OpenCode's data directory (opencode `packages/util/src/global-roots.ts`: `XDG_DATA_HOME`, an empty value ignored). */
export function opencodeDataDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "opencode");
}

export class OpencodeAuthFile extends ForeignKeySourcePort {
  readonly tool = "opencode";

  constructor(private readonly dataDir: string) {
    super();
  }

  async apiKey(entry: ProviderId): Promise<string> {
    const path = join(this.dataDir, "auth.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new InvalidRequestError(`cannot read OpenCode's credential file ${path}: ${(error as NodeJS.ErrnoException).code}`);
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch {
      throw new InvalidRequestError(`OpenCode's credential file ${path} is not JSON`);
    }
    const value = isJsonObject(file) ? file[entry] : undefined;
    if (isJsonObject(value) && value["type"] === "api" && typeof value["key"] === "string" && value["key"] !== "") return value["key"];
    if (isJsonObject(value) && value["type"] === "oauth") {
      throw new InvalidRequestError(`OpenCode stores a sign-in for ${entry}, not an API key; only API keys are imported (sign in with \`accounts-proxy login ${entry}\`)`);
    }
    throw new InvalidRequestError(`OpenCode stores no API key for ${entry} in ${path}`);
  }
}
