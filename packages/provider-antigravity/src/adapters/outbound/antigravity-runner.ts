// One logical generation through cloudcode-pa (P4 plan §2.3), used by the native Gemini cell. Port of opencode-antigravity-auth @ 5c6f7c2 StreamChatUseCase.ts: trajectory
// snapshot computed ONCE per logical request and reused across retries; one 401 force-rotation; transient geo-gate
// retries (2 s, 8 s) only before anything was yielded; the step counter advances only after a completed stream.
// Difference G5: the account is refreshed proactively before the call (source used bare loadActive); the 401 retry
// additionally requires that nothing was yielded yet.
import { ProviderAuthRequiredError } from "@accounts-proxy/core/domain/errors.ts";
import type { ClockPort, LoggerPort, RandomPort, TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { activeProject } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import { LOCATION_RETRY_BACKOFF_MS } from "@accounts-proxy/provider-antigravity/domain/constants.ts";
import { TrajectoryState } from "@accounts-proxy/provider-antigravity/domain/trajectory.ts";
import { isLocationGate, isUnauthorized } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";
import {
  AntigravityRunnerPort,
  type ActiveAccount,
  type AntigravityApiPort,
  type AntigravitySessionPort,
  type AntigravityStatePort,
  type RunInput,
} from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

export class AntigravityRunner extends AntigravityRunnerPort {
  private trajectory: Promise<TrajectoryState> | undefined;

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

  async *run<T>(input: RunInput<T>): AsyncIterable<T> {
    const trajectory = await this.init();
    const snapshot = trajectory.begin(input.modelWireId, input.modelEnum, input.turns);
    const body = input.build(snapshot);
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
        const envelopes = this.api.streamGenerate({ project, requestId: snapshot.requestId, body, modelWireId: input.modelWireId }, active.account.tokens, input.signal);
        for await (const envelope of envelopes) {
          yielded = true;
          yield input.map(envelope);
        }
        trajectory.complete();
        return;
      } catch (error) {
        if (isUnauthorized(error) && !rotatedOnce && !yielded && active.account.tokens.refreshToken !== undefined) {
          rotatedOnce = true;
          pinned = await this.session.forceRenew(active);
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

  private init(): Promise<TrajectoryState> {
    this.trajectory ??= this.state
      .sessionId()
      .then((sessionId) => new TrajectoryState({ sessionUuid: this.random.uuid(), sessionId, uuid: () => this.random.uuid(), now: () => this.clock.now() }));
    return this.trajectory;
  }
}
