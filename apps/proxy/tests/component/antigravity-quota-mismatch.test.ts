import { describe, expect, test } from "bun:test";
import { QuotaExhaustedError } from "@accounts-proxy/core/domain/errors.ts";
import { OAuthSessionPort } from "@accounts-proxy/core/ports/outbound/session.ts";
import { TimerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { FixedClock, MemoryLogger, SequenceRandom } from "@accounts-proxy/test-support/fakes.ts";
import { AntigravityRunner } from "@accounts-proxy/provider-antigravity/adapters/outbound/antigravity-runner.ts";
import type { QuotaAdvert } from "@accounts-proxy/provider-antigravity/domain/quota-mismatch.ts";
import type { StreamEnvelope } from "@accounts-proxy/provider-antigravity/domain/generate.ts";
import type { GenerateParams } from "@accounts-proxy/provider-antigravity/domain/upstream.ts";
import type { AntigravityAccount, AuthTokens } from "@accounts-proxy/provider-antigravity/domain/account.ts";
import { AntigravityApiPort, AntigravityStatePort, type ActiveAccount } from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

// uc-generate-429-surfaced: 429 through the generate path warns with the advertised state, error unchanged.
const model = "gemini-3.8-flash-medium";
const project = "aicode-consumers";
const resetTime = "2026-11-30T01:18:56Z";
const turns = [{ role: "user" as const, text: "hi" }];
const tokens: AuthTokens = { accessToken: "at", refreshToken: "rt", expiresAt: 9_000_000_000_000 };

class RejectingApi extends AntigravityApiPort {
  readonly streams: GenerateParams[] = [];
  constructor(private readonly failure: unknown) {
    super();
  }
  async loadCodeAssist(): Promise<Record<string, unknown>> {
    return {};
  }
  async onboardUser(): Promise<Record<string, unknown>> {
    return {};
  }
  async fetchUserInfo(): Promise<{ readonly email?: string }> {
    return { email: "me@x" };
  }
  async fetchAvailableModels(): Promise<Record<string, unknown>> {
    return {};
  }
  async retrieveUserQuotaSummary(): Promise<Record<string, unknown>> {
    return {};
  }
  streamGenerate(params: GenerateParams, _tokens: AuthTokens, _signal: AbortSignal | undefined): AsyncIterable<StreamEnvelope> {
    this.streams.push(params);
    const failure = this.failure;
    return (async function* () {
      throw failure;
      yield undefined as never;
    })();
  }
}

class FixedSession extends OAuthSessionPort<AntigravityAccount> {
  constructor(
    private current: ActiveAccount = {
      id: "me@x",
      account: { email: "me@x", tokens, projectIds: [project], activeProjectId: project },
    },
  ) {
    super();
  }
  async active(): Promise<ActiveAccount> {
    return this.current;
  }
  async forceRenew(seen: ActiveAccount): Promise<ActiveAccount> {
    return seen;
  }
}

class MemoryState extends AntigravityStatePort {
  async sessionId(): Promise<string> {
    return "-42";
  }
  async signatures(): Promise<Readonly<Record<string, string>>> {
    return {};
  }
  async saveSignature(): Promise<void> {}
}

class InstantTimer extends TimerPort {
  readonly waits: number[] = [];
  async sleep(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

function make(failure: unknown, advert: (modelWireId: string) => QuotaAdvert | undefined) {
  const api = new RejectingApi(failure);
  const logger = new MemoryLogger();
  const runner = new AntigravityRunner(api, new FixedSession(), new MemoryState(), new SequenceRandom(), new FixedClock(77), new InstantTimer(), logger, undefined, advert);
  const run = () =>
    runner.run({
      modelWireId: model,
      modelEnum: "MODEL_PLACEHOLDER_M319",
      turns,
      build: (snapshot) => ({ labels: snapshot.labels, sessionId: snapshot.sessionId }),
      map: (envelope) => envelope,
    });
  return { api, logger, run };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("uc-generate-429-surfaced warns with advertised state", () => {
  test("429 + advert 100% throws unchanged and warns once with model, project, percent, reset", async () => {
    const failure = new QuotaExhaustedError("antigravity", "RESOURCE_EXHAUSTED");
    const { logger, run } = make(failure, () => ({ remainingFraction: 1, resetTime }));
    const caught = await drain(run()).then(
      () => {
        throw new Error("expected QuotaExhaustedError");
      },
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    expect(caught).toBeInstanceOf(QuotaExhaustedError);
    expect((caught as QuotaExhaustedError).httpStatus).toBe(429);
    expect((caught as QuotaExhaustedError).code).toBe("quota_exhausted");
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain(model);
    expect(logger.lines[0]).toContain(project);
    expect(logger.lines[0]).toContain("100%");
    expect(logger.lines[0]).toContain(resetTime);
  });

  test("negative: 429 + advert 0% throws with no warn", async () => {
    const failure = new QuotaExhaustedError("antigravity", "RESOURCE_EXHAUSTED");
    const { logger, run } = make(failure, () => ({ remainingFraction: 0, resetTime }));
    const caught = await drain(run()).then(
      () => {
        throw new Error("expected QuotaExhaustedError");
      },
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    expect(logger.lines).toHaveLength(0);
  });
});
