// pi's side of the extension (architecture design §5): provider registration, warnings and the environment.
// Field lists quote pi 1.5.2 dist/core/extensions/types.d.ts:1459-1547 (ProviderConfig, ProviderChatModelConfig).
import type { JsonObject } from "@accounts-proxy/pi-extension/ports/outbound/proxy-discovery.ts";

/** Per-million-token cost rates, as pi's models.json schema requires them. */
export type PiModelCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/** One model of a registered provider: pi requires id, name, input, cost, reasoning, contextWindow, maxTokens. */
export type PiModelConfig = {
  readonly id: string;
  readonly name: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly input: readonly ("text" | "image")[];
  readonly cost: PiModelCost;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: JsonObject;
  readonly compat?: JsonObject;
};

/** One provider registration: the models plus a refresh hook returning the provider's current models. */
export type PiProviderConfig = {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly api?: string;
  readonly models: readonly PiModelConfig[];
  readonly refreshModels?: () => Promise<readonly PiModelConfig[]>;
};

export abstract class PiHostPort {
  /** Register one provider with pi. */
  abstract registerProvider(id: string, config: PiProviderConfig): void;
  /** Warn the user (the service never throws, so every failure surfaces here). */
  abstract warn(message: string): void;
  /** Read an environment variable. */
  abstract readEnv(name: string): string | undefined;
  /** Set an environment variable for pi's process. */
  abstract setEnv(name: string, value: string): void;
}
