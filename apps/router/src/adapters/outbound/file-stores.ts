// The router's own durable stores under its data directory (plan D5: never Claude Code's or the plugins' files).
//   accounts-<provider>.json   AccountPool per provider (credentials; written 0600)
//   state/<key>.json           small provider state (device/session ids, catalog cache, thought signatures)
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
import { CredentialStorePort } from "@inference-router/core/ports/outbound/credentials.ts";
import { KeyValueStorePort } from "@inference-router/core/ports/outbound/state.ts";

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
  return isJsonObject(value) && value.provider === provider && typeof value.id === "string" && typeof value.label === "string" && isJsonObject(value.data);
}

export class FileCredentialStore extends CredentialStorePort {
  constructor(private readonly directory: string) {
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

  save(provider: ProviderId, pool: AccountPool): Promise<void> {
    return writeJsonAtomic(this.path(provider), pool, PRIVATE_FILE_MODE);
  }
}

const KEY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

export class FileKeyValueStore extends KeyValueStorePort {
  constructor(private readonly directory: string) {
    super();
  }

  path(key: string): string {
    if (!KEY.test(key)) throw new Error(`invalid state key ${JSON.stringify(key)}`);
    return join(this.directory, "state", ...key.split("/")) + ".json";
  }

  async read(key: string): Promise<JsonValue | undefined> {
    return (await readJson(this.path(key))) as JsonValue | undefined;
  }

  write(key: string, value: JsonValue): Promise<void> {
    return writeJsonAtomic(this.path(key), value, PRIVATE_FILE_MODE);
  }
}
