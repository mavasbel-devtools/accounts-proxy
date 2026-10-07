// antigravity provider (ProviderPort). P3 scope: model listing with the advertised-window law (limit law 4). The
// near-native Gemini cell (P4) and the translated cells (P5) are wired onto AntigravityChatPort once the P0-LIVE
// captures settle the native-Gemini request/response mapping; until then they answer unsupported_feature.
import type { CanonicalEvent } from "@inference-router/core/domain/canonical/events.ts";
import type { CanonicalRequest } from "@inference-router/core/domain/canonical/request.ts";
import { UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";
import type { ModelInfo } from "@inference-router/core/domain/models.ts";
import type { Feature } from "@inference-router/core/domain/services/feature-support.ts";
import type { HttpResponse, RawRequest } from "@inference-router/core/domain/wire.ts";
import { ProviderPort } from "@inference-router/core/ports/outbound/provider.ts";
import { advertisedLimits } from "../../domain/catalog.ts";
import type { AntigravityCatalogPort } from "../../ports/outbound/antigravity.ts";

const PENDING = "antigravity (request cells arrive in P4/P5)";

export class AntigravityProvider extends ProviderPort {
  readonly id = "antigravity";
  readonly nativeDialect = "gemini";

  constructor(private readonly catalog: AntigravityCatalogPort) {
    super();
  }

  capabilities(): ReadonlySet<Feature> {
    return new Set<Feature>();
  }

  async models(): Promise<readonly ModelInfo[]> {
    return (await this.catalog.descriptors()).map((d) => {
      const limits = advertisedLimits(d);
      return {
        address: { provider: this.id, model: d.wireId },
        displayName: d.displayName,
        ...(limits !== undefined ? { contextWindow: limits.context, maxOutputTokens: limits.output } : {}),
      };
    });
  }

  async *stream(_request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    throw new UnsupportedFeatureError(["translated_request"], PENDING);
  }

  async countTokens(_request: CanonicalRequest): Promise<number> {
    throw new UnsupportedFeatureError(["translated_request"], PENDING);
  }

  async passthrough(_model: string, _request: RawRequest): Promise<HttpResponse> {
    throw new UnsupportedFeatureError(["native_request"], PENDING);
  }
}
