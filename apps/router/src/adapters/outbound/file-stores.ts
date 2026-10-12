// The router's own durable stores under its data directory (plan D5: never Claude Code's or the plugins' files).
//   accounts-<provider>.json   AccountPool per provider (credentials; written 0600)
//   state/<key>.json           small provider state (device/session ids, catalog cache, thought signatures)
//   token.json                 the router token clients present (written 0600)
// Writes are atomic (temp file in the same directory + rename). A UTF-8 BOM is tolerated on read (lesson of the
// source plugin's 2026-08-28 BOM incident). A corrupt file is an error, never silently treated as empty — an empty
// pool written back would destroy the user's accounts. Directories the router creates are 0700 (owner only), like
// ~/.ssh: they hold credentials. `mode` applies only to directories mkdir creates; an existing one is left as it is.
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EMPTY_POOL, type AccountCredential, type AccountPool } from "@inference-router/core/domain/accounts.ts";
import { isJsonObject, type JsonValue } from "@inference-router/core/domain/json.ts";
import type { ProviderId } from "@inference-router/core/domain/models.ts";
import { CredentialStorePort, type PoolChange } from "@inference-router/core/ports/outbound/credentials.ts";
import { RouterTokenStorePort } from "@inference-router/core/ports/outbound/router-token.ts";
import { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";
import type { LockPort } from "@inference-router/core/ports/outbound/system.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class StoreCorruptError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path} is not valid (${detail}); fix or remove it, then retry`);
    this.name = "StoreCorruptError";
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new StoreCorruptError(path, String(error));
  }
}

/** The filesystem calls an atomic write needs (a seam: a failed write whose temp file cannot be removed is otherwise untestable). */
export type AtomicWriteFs = Pick<typeof nodeFs, "mkdir" | "writeFile" | "rename" | "unlink">;

export async function writeJsonAtomic(path: string, value: unknown, mode: number, fs: AtomicWriteFs = nodeFs): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    await fs.rename(temp, path);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

function isAccount(value: unknown, provider: ProviderId): value is AccountCredential {
  return isJsonObject(value) && value.provider === provider && typeof value.id === "string" && typeof value.label === "string" && isJsonObject(value.data) && (value.needsLogin === undefined || typeof value.needsLogin === "string");
}

/**
 * Account pools, one file per provider. `update` holds the `accounts-<provider>` lock across processes for the whole
 * read → change → write (plan v4 H1); a change that returns the pool it was given writes nothing.
 */
export class FileCredentialStore extends CredentialStorePort {
  constructor(
    private readonly directory: string,
    private readonly lock: LockPort,
  ) {
    super();
  }

  path(provider: ProviderId): string {
    return join(this.directory, `accounts-${provider}.json`);
  }

  async load(provider: ProviderId): Promise<AccountPool> {
    const path = this.path(provider);
    const value = await readJson(path);
    if (value === undefined) return EMPTY_POOL;
    if (!isJsonObject(value) || !Array.isArray(value.accounts) || !value.accounts.every((a) => isAccount(a, provider))) {
      throw new StoreCorruptError(path, "expected { accounts: AccountCredential[], activeId? }");
    }
    const accounts = value.accounts as unknown as AccountCredential[];
    return typeof value.activeId === "string" ? { accounts, activeId: value.activeId } : { accounts };
  }

  update(provider: ProviderId, change: PoolChange): Promise<AccountPool> {
    return this.lock.withLock(`accounts-${provider}`, async () => {
      const pool = await this.load(provider);
      const next = change(pool);
      if (next !== pool) await writeJsonAtomic(this.path(provider), next, PRIVATE_FILE_MODE);
      return next;
    });
  }
}

export class FileKeyValueStore extends KeyValueStorePort {
  constructor(private readonly directory: string) {
    super();
  }

  /** Keys are the providers' constant `<provider>/<name>` keys (no user input reaches them). */
  path(key: string): string {
    return join(this.directory, "state", ...key.split("/")) + ".json";
  }

  async read(key: string): Promise<JsonValue | undefined> {
    return (await readJson(this.path(key))) as JsonValue | undefined;
  }

  write(key: string, value: JsonValue): Promise<void> {
    return writeJsonAtomic(this.path(key), value, PRIVATE_FILE_MODE);
  }
}

/** The router token, `<data>/token.json` = `{"token": "<base64url>"}`, written 0600. */
export class FileRouterTokenStore extends RouterTokenStorePort {
  constructor(private readonly directory: string) {
    super();
  }

  path(): string {
    return join(this.directory, "token.json");
  }

  async read(): Promise<string | undefined> {
    const value = await readJson(this.path());
    if (value === undefined) return undefined;
    if (!isJsonObject(value) || typeof value.token !== "string" || value.token.length === 0) throw new StoreCorruptError(this.path(), 'expected { "token": "<router token>" }');
    return value.token;
  }

  write(token: string): Promise<void> {
    return writeJsonAtomic(this.path(), { token }, PRIVATE_FILE_MODE);
  }
}
