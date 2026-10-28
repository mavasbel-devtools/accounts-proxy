// The proxy's own durable stores (plan D5: never Claude Code's or the plugins' files).
//   accounts.json              every provider's AccountPool (credentials; written 0600), by default in the
//                              repository's .cache/ (plan 2026-10-26-23-32), not in the data directory
//   state/<key>.json           small provider state (device/session ids, catalog cache, thought signatures)
//   token.json                 the proxy token clients present (written 0600)
// Writes are atomic (temp file in the same directory + rename). A UTF-8 BOM is tolerated on read (lesson of the
// source plugin's 2026-08-28 BOM incident). A corrupt file is an error, never silently treated as empty — an empty
// pool written back would destroy the user's accounts. Directories the proxy creates are 0700 (owner only), like
// ~/.ssh: they hold credentials. `mode` applies only to directories mkdir creates; an existing one is left as it is.
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_POOL, type AccountCredential, type AccountPool } from "@accounts-proxy/core/domain/accounts.ts";
import { isJsonObject, type JsonValue } from "@accounts-proxy/core/domain/json.ts";
import type { ProviderId } from "@accounts-proxy/core/domain/models.ts";
import { CredentialStorePort, type PoolChange } from "@accounts-proxy/core/ports/outbound/credentials.ts";
import { ProxyTokenStorePort } from "@accounts-proxy/core/ports/outbound/proxy-token.ts";
import { KeyValueStorePort } from "@accounts-proxy/core/ports/outbound/state.ts";
import type { LockPort } from "@accounts-proxy/core/ports/outbound/system.ts";

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

export async function writeJsonAtomic(path: string, value: unknown, mode: number, fs: AtomicWriteFs): Promise<void> {
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

/** The accounts file's schema tag (plan 2026-10-26-23-32 A1). */
export const ACCOUNTS_FILE_SCHEMA = "accounts-proxy/accounts/1";
/** How many times `update` re-applies its change when the file was edited between its read and its write (A3b). */
export const ACCOUNTS_WRITE_ATTEMPTS = 3;
/** The single lock every writer of the accounts file takes (A3, A3a). */
export const ACCOUNTS_LOCK = "accounts";

type AccountsDocument = { schema: string; providers: Record<string, JsonValue> } & Record<string, JsonValue>;

export class AccountsFileChangedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed during each of ${ACCOUNTS_WRITE_ATTEMPTS} writes (edited while the proxy was writing); retry`);
    this.name = "AccountsFileChangedError";
  }
}

/** The filesystem calls the accounts file needs (a seam: the hand-edit race of A3b is otherwise untestable end to end). */
export type AccountsFileFs = Pick<typeof nodeFs, "mkdir" | "readFile" | "writeFile" | "rename" | "unlink">;

/**
 * Every provider's accounts in one JSON file (plan 2026-10-26-23-32 A1–A3b):
 * `{ "schema": "accounts-proxy/accounts/1", "providers": { "<provider>": { "accounts": [...], "activeId"?: "..." } } }`.
 * Every `load` reads the file, so a hand edit applies to the next request. `update` holds the one `accounts` lock for
 * the read → change → write; the write is a temp file renamed over the file after the file is read again: when its
 * bytes changed since the first read (an editor saved meanwhile), the change is applied again to the new content.
 * A file that is not JSON or not this shape is a StoreCorruptError and is never overwritten. A provider whose pool is
 * empty with no active account is left out of the file.
 */
export class AccountsFileStore extends CredentialStorePort {
  constructor(
    readonly path: string,
    private readonly lock: LockPort,
    private readonly fs: AccountsFileFs,
  ) {
    super();
  }

  async load(provider: ProviderId): Promise<AccountPool> {
    return this.poolOf(this.parse(await this.read()), provider);
  }

  update(provider: ProviderId, change: PoolChange): Promise<AccountPool> {
    return this.lock.withLock(ACCOUNTS_LOCK, async () => {
      for (let attempt = 0; attempt < ACCOUNTS_WRITE_ATTEMPTS; attempt++) {
        const before = await this.read();
        const document = this.parse(before);
        const pool = this.poolOf(document, provider);
        const next = change(pool);
        if (next === pool) return pool;
        if (await this.write(this.withPool(document, provider, next), before)) return next;
      }
      throw new AccountsFileChangedError(this.path);
    });
  }

  private async read(): Promise<string | undefined> {
    try {
      return await this.fs.readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private parse(text: string | undefined): AccountsDocument {
    if (text === undefined) return { schema: ACCOUNTS_FILE_SCHEMA, providers: {} };
    let value: unknown;
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      throw new StoreCorruptError(this.path, String(error));
    }
    if (!isJsonObject(value) || value.schema !== ACCOUNTS_FILE_SCHEMA || !isJsonObject(value.providers)) {
      throw new StoreCorruptError(this.path, `expected { "schema": "${ACCOUNTS_FILE_SCHEMA}", "providers": { ... } }`);
    }
    return value as AccountsDocument;
  }

  private poolOf(document: AccountsDocument, provider: ProviderId): AccountPool {
    const entry = document.providers[provider];
    if (entry === undefined) return EMPTY_POOL;
    if (!isJsonObject(entry) || !Array.isArray(entry.accounts) || !entry.accounts.every((a) => isAccount(a, provider)) || (entry.activeId !== undefined && typeof entry.activeId !== "string")) {
      throw new StoreCorruptError(this.path, `providers.${provider}: expected { accounts: AccountCredential[], activeId? }`);
    }
    const accounts = entry.accounts as unknown as AccountCredential[];
    return typeof entry.activeId === "string" ? { accounts, activeId: entry.activeId } : { accounts };
  }

  private withPool(document: AccountsDocument, provider: ProviderId, pool: AccountPool): AccountsDocument {
    const providers = { ...document.providers };
    if (pool.accounts.length === 0 && pool.activeId === undefined) delete providers[provider];
    else providers[provider] = pool as unknown as JsonValue;
    return { ...document, providers };
  }

  /** Temp file, read again, rename only when the file is still what was read; false when it changed (A3b). */
  private async write(document: AccountsDocument, before: string | undefined): Promise<boolean> {
    await this.fs.mkdir(dirname(this.path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await this.fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      if ((await this.read()) !== before) {
        await this.fs.unlink(temp);
        return false;
      }
      await this.fs.rename(temp, this.path);
      return true;
    } catch (error) {
      await this.fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Hermetic-test hook (ACCOUNTS_PROXY_TEST_ACCOUNTS_EDITED=<n>): the first `n` writes of the accounts file see a hand
 * edit saved between their read and their rename (a newline appended to the file), as when the user saves the file
 * in an editor while the proxy writes it (A3b).
 */
export function editedAccountsFs(fs: AccountsFileFs, path: string, times: number): AccountsFileFs {
  let left = times;
  const writeFile = (async (file: string, data: string, options: { encoding: "utf8"; mode: number }) => {
    await fs.writeFile(file, data, options);
    if (left > 0) {
      left -= 1;
      appendFileSync(path, "\n");
    }
  }) as AccountsFileFs["writeFile"];
  return { ...fs, writeFile };
}

/** The lock a state file write takes (plan 2026-10-27-23-29 W1). */
export const STATE_LOCK = "state";
/** The lock the proxy token's creation takes (W1). */
export const TOKEN_LOCK = "token";

export class FileKeyValueStore extends KeyValueStorePort {
  constructor(
    private readonly directory: string,
    private readonly lock: LockPort,
    private readonly fs: AtomicWriteFs = nodeFs,
  ) {
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
    return this.lock.withLock(STATE_LOCK, () => writeJsonAtomic(this.path(key), value, PRIVATE_FILE_MODE, this.fs));
  }
}

/** The proxy token, `<data>/token.json` = `{"token": "<base64url>"}`, written 0600. */
export class FileProxyTokenStore extends ProxyTokenStorePort {
  constructor(
    private readonly directory: string,
    private readonly lock: LockPort,
    private readonly fs: AtomicWriteFs = nodeFs,
  ) {
    super();
  }

  path(): string {
    return join(this.directory, "token.json");
  }

  async read(): Promise<string | undefined> {
    const value = await readJson(this.path());
    if (value === undefined) return undefined;
    if (!isJsonObject(value) || typeof value.token !== "string" || value.token.length === 0) throw new StoreCorruptError(this.path(), 'expected { "token": "<proxy token>" }');
    return value.token;
  }

  /** Under the lock the token is read again: when another process created one meanwhile, that one is kept and returned. */
  createIfAbsent(token: string): Promise<string> {
    return this.lock.withLock(TOKEN_LOCK, async () => {
      const existing = await this.read();
      if (existing !== undefined) return existing;
      await writeJsonAtomic(this.path(), { token }, PRIVATE_FILE_MODE, this.fs);
      return token;
    });
  }
}
