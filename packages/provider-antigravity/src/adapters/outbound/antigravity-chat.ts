// Streamed chat through cloudcode-pa. Port of opencode-antigravity-auth @ 5c6f7c2 StreamChatUseCase.ts:
// trajectory snapshot computed ONCE per logical request and reused across retries; one 401 force-rotation;
// transient geo-gate retries (2 s, 8 s) only before any chunk; a clean end without finishReason yields STOP; the
// step counter advances only after a completed stream. Differences: G5 the account is refreshed proactively before
// the call (source used bare loadActive); the 401 retry additionally requires that nothing was yielded yet.
import { ProviderAuthRequiredError } from "@inference-router/core/domain/errors.ts";
import type { ClockPort, LoggerPort, RandomPort, TimerPort } from "@inference-router/core/ports/outbound/system.ts";
import { activeProject } from "@inference-router/provider-antigravity/domain/account.ts";
import { LOCATION_RETRY_BACKOFF_MS } from "@inference-router/provider-antigravity/domain/constants.ts";
import { chunkHasContent, GenerateCodec, type ChatChunk, type ChatRequest } from "@inference-router/provider-antigravity/domain/generate.ts";
import { TrajectoryState } from "@inference-router/provider-antigravity/domain/trajectory.ts";
import { isLocationGate, isUnauthorized } from "@inference-router/provider-antigravity/domain/upstream.ts";
import {
  AntigravityChatPort,
  type ActiveAccount,
  type AntigravityApiPort,
  type AntigravitySessionPort,
  type AntigravityStatePort,
} from "@inference-router/provider-antigravity/ports/outbound/antigravity.ts";

export class AntigravityChat extends AntigravityChatPort {
  private ready: Promise<{ trajectory: TrajectoryState; codec: GenerateCodec }> | undefined;

  constructor(
    private readonly api: AntigravityApiPort,
    private readonly session: AntigravitySessionPort,
    private readonly state: AntigravityStatePort,
    private readonly random: RandomPort,
    private readonly clock: ClockPort,
    private readonly timer: TimerPort,
    private readonly logger: LoggerPort,
    private readonly locationBackoffMs: readonly number[] = LOCATION_RETRY_BACKOFF_MS,
  ) {
    super();
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const { trajectory, codec } = await this.init();
    const snapshot = trajectory.begin(request.modelWireId, request.modelEnum ?? "", request.messages);
    const body = codec.toGenerateBody(request, { labels: snapshot.labels, sessionId: snapshot.sessionId }) as unknown as Record<string, unknown>;
    let rotatedOnce = false;
    let locationRetries = 0;
    let pinned: ActiveAccount | undefined;
    for (;;) {
      const active = pinned ?? (await this.session.active());
      pinned = undefined;
      const project = activeProject(active.account);
      if (project === undefined) throw new ProviderAuthRequiredError("antigravity", `account ${active.id} has no project assigned`);
      let yielded = false;
      try {
        let finished = false;
        for await (const envelope of this.api.streamGenerate({ project, requestId: snapshot.requestId, body, modelWireId: request.modelWireId }, active.account.tokens)) {
          const chunk = codec.envelopeToChunk(envelope);
          if (chunk !== undefined && chunkHasContent(chunk)) {
            if (chunk.finishReason !== undefined) finished = true;
            yielded = true;
            yield chunk;
          }
        }
        if (!finished) yield { finishReason: "STOP" };
        trajectory.complete();
        return;
      } catch (error) {
        if (isUnauthorized(error) && !rotatedOnce && !yielded && active.account.tokens.refreshToken !== undefined) {
          rotatedOnce = true;
          pinned = await this.session.forceRotate(active);
          this.logger.info("antigravity: rotated token after 401");
          continue;
        }
        if (isLocationGate(error) && !yielded && locationRetries < this.locationBackoffMs.length) {
          const backoff = this.locationBackoffMs[locationRetries]!;
          locationRetries += 1;
          this.logger.warn(`antigravity: transient upstream geo gate; retry ${locationRetries}/${this.locationBackoffMs.length} after ${backoff}ms`);
          await this.timer.sleep(backoff);
          continue;
        }
        throw error;
      }
    }
  }

  private init() {
    this.ready ??= (async () => {
      const [sessionId, signatures] = await Promise.all([this.state.sessionId(), this.state.signatures()]);
      const trajectory = new TrajectoryState({ sessionUuid: this.random.uuid(), sessionId, uuid: () => this.random.uuid(), now: () => this.clock.now() });
      const codec = new GenerateCodec(signatures, {
        onSignature: (id, signature) => {
          this.state.saveSignature(id, signature).catch((error: unknown) => this.logger.warn(`antigravity: signature persist failed (${String(error)})`));
        },
        warn: (message) => this.logger.warn(`antigravity: ${message}`),
      });
      return { trajectory, codec };
    })();
    return this.ready;
  }
}
