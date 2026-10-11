// Streamed chat (the plugin relay's OpenAI-shaped ChatRequest) through the shared runner. Port of
// opencode-antigravity-auth @ 5c6f7c2 StreamChatUseCase.ts: only content chunks count as output (a retry stays
// possible until one was yielded), and a clean end without finishReason yields STOP.
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { chunkHasContent, GenerateCodec, type ChatChunk, type ChatRequest } from "@inference-router/provider-antigravity/domain/generate.ts";
import { AntigravityChatPort, type AntigravityRunnerPort, type AntigravityStatePort } from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export class AntigravityChat extends AntigravityChatPort {
  private codec: Promise<GenerateCodec> | undefined;

  constructor(
    private readonly runner: AntigravityRunnerPort,
    private readonly state: AntigravityStatePort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const codec = await this.init();
    let finished = false;
    const chunks = this.runner.run({
      modelWireId: request.modelWireId,
      modelEnum: request.modelEnum ?? "",
      turns: request.messages,
      build: (snapshot) => codec.toGenerateBody(request, { labels: snapshot.labels, sessionId: snapshot.sessionId }) as unknown as Record<string, unknown>,
      map: (envelope) => {
        const chunk = codec.envelopeToChunk(envelope);
        return chunk !== undefined && chunkHasContent(chunk) ? chunk : undefined;
      },
    });
    for await (const chunk of chunks) {
      if (chunk.finishReason !== undefined) finished = true;
      yield chunk;
    }
    if (!finished) yield { finishReason: "STOP" };
  }

  private init(): Promise<GenerateCodec> {
    this.codec ??= this.state.signatures().then(
      (signatures) =>
        new GenerateCodec(signatures, {
          onSignature: (id, signature) => {
            this.state.saveSignature(id, signature).catch((error: unknown) => this.logger.warn(`antigravity: signature persist failed (${String(error)})`));
          },
          warn: (message) => this.logger.warn(`antigravity: ${message}`),
        }),
    );
    return this.codec;
  }
}
