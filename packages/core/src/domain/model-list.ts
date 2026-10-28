// Model-list reuse rules (plan 2026-10-28-13-40 M1–M6): why a list is fetched, and when a failed fetch is tried again.
import type { ModelsSource } from "@accounts-proxy/core/domain/models.ts";

/**
 * Why a model list is fetched: `start` the daemon's start-up fetch, `first use` the first read in a process with no
 * usable stored copy, `stale` older than `modelListMaxAgeMinutes`, `retry` after a failed fetch, `refresh` an explicit
 * refresh, `unknown model` a request for a model the kept list does not have, `account changed` the kept list is
 * another account's (Antigravity, whose list is the signed-in account's).
 */
export type ListFetchReason = "start" | "first use" | "stale" | "retry" | "refresh" | "unknown model" | "account changed";

/** A failed fetch is tried again, in the background, on the first read at least this long after it (M4). */
export const MODEL_LIST_RETRY_MS = 60_000;

/** A model list with where it came from. */
export type KeptList<T> = { readonly source: ModelsSource; readonly value: T };

/** A fetched list as kept in memory and stored: when it was fetched and what it was. */
export type ListSnapshot<T> = { readonly fetchedAt: number; readonly value: T };
