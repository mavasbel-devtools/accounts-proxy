import type { JsonValue } from "@inference-router/core/domain/json.ts";

/**
 * Small durable provider state that is not a credential: device identity, catalog caches, signature
 * caches. Keys are namespaced by the caller ("<provider>/<name>"). Writes are atomic in the adapter.
 */
export abstract class KeyValueStorePort {
  abstract read(key: string): Promise<JsonValue | undefined>;
  abstract write(key: string, value: JsonValue): Promise<void>;
}
