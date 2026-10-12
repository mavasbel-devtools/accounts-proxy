// The near-native Gemini cell over the shared runner: each upstream envelope is unwrapped to the public
// GenerateContentResponse (`envelope.response`, or the envelope itself when it is a bare response — law 10 accepts
// both), and every signed functionCall it carries is cached in memory and in the durable store (law 6).
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import type { StreamEnvelope } from "@inference-router/provider-antigravity/domain/generate.ts";
import { innerRequest, signedCalls, type GeminiResponse } from "@inference-router/provider-antigravity/domain/native-gemini.ts";
import {
  AntigravityNativePort,
  type AntigravityRunnerPort,
  type AntigravityStatePort,
  type NativeInput,
} from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export function unwrapEnvelope(envelope: StreamEnvelope): GeminiResponse {
  return (envelope.response ?? envelope) as GeminiResponse;
}

export class AntigravityNative extends AntigravityNativePort {
  private cache: Promise<Map<string, string>> | undefined;

  constructor(
    private readonly runner: AntigravityRunnerPort,
    private readonly state: AntigravityStatePort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async signatures(): Promise<Readonly<Record<string, string>>> {
    return Object.fromEntries(await this.load());
  }

  async *generate(input: NativeInput): AsyncIterable<GeminiResponse> {
    const cache = await this.load();
    yield* this.runner.run({
      modelWireId: input.model.wireId,
      modelEnum: input.model.enumPlaceholder,
      turns: input.prepared.turns,
      build: (snapshot) => innerRequest(input.prepared, snapshot),
      map: (envelope) => {
        const response = unwrapEnvelope(envelope);
        for (const { id, signature } of signedCalls(response)) {
          cache.set(id, signature);
          this.state.saveSignature(id, signature).catch((error: unknown) => this.logger.warn(`antigravity: signature persist failed (${String(error)})`));
        }
        return response;
      },
      signal: input.signal,
    });
  }

  private load(): Promise<Map<string, string>> {
    this.cache ??= this.state.signatures().then((stored) => new Map(Object.entries(stored)));
    return this.cache;
  }
}
