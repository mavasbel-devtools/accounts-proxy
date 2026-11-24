// antigravity provider (ProviderPort). Models: the live catalog with the advertised-window law (limit law 4). Native
// cell (P4): public Gemini `:streamGenerateContent` (SSE with `alt=sse`, else a JSON array written incrementally) and
// `:generateContent` (the stream merged, decision Q4) through AntigravityNativePort. `:countTokens` is unsupported:
// cloudcode-pa has no token-count endpoint (SPEC.md §2). Errors before the first byte are thrown (the HTTP adapter
// renders them in the Gemini shape); after it, a final error element closes the stream.
import { asProxyError, InvalidRequestError, UnknownModelError, UnsupportedFeatureError, UpstreamError } from "@accounts-proxy/core/domain/errors.ts";
import type { ModelCatalog, WireFormat } from "@accounts-proxy/core/domain/models.ts";
import { errorMessage } from "@accounts-proxy/core/domain/services/error-message.ts";
import { googleErrorEnvelope } from "@accounts-proxy/core/domain/services/google-error.ts";
import { parseJsonBody } from "@accounts-proxy/core/domain/services/json-body.ts";
import { bodyOf, DROPPED_HEADER, type HttpResponse, type RawRequest } from "@accounts-proxy/core/domain/wire.ts";
import { ProviderPort } from "@accounts-proxy/core/ports/outbound/provider.ts";
import type { LoggerPort } from "@accounts-proxy/core/ports/outbound/system.ts";
import { advertisedLimits, descriptorDetails } from "@accounts-proxy/provider-antigravity/domain/catalog.ts";
import { applyReverseAliases, flushReverseBuffer, reverseStreamChunk } from "@accounts-proxy/provider-antigravity/domain/namespace-alias.ts";
import { aggregateResponses, geminiMethod, prepareGeminiRequest, type GeminiResponse } from "@accounts-proxy/provider-antigravity/domain/native-gemini.ts";
import type { AntigravityCatalogPort, AntigravityListing, AntigravityNativePort } from "@accounts-proxy/provider-antigravity/ports/outbound/antigravity.ts";

/** Law 11 for the native cell: a stream that ends without any response is an upstream failure, never an empty 200. */
const emptyStream = () => new UpstreamError("antigravity", 502, "empty stream: the upstream ended without any response");

export class AntigravityProvider extends ProviderPort {
  readonly id = "antigravity";
  /** The one format this provider serves natively, for every model. */
  readonly formats: readonly WireFormat[] = ["gemini"];

  constructor(
    private readonly catalog: AntigravityCatalogPort,
    private readonly native: AntigravityNativePort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async nativeFormats(_model: string): Promise<ReadonlySet<WireFormat>> {
    return new Set(this.formats);
  }

  models(): Promise<ModelCatalog> {
    return this.catalogOf(this.catalog.listing());
  }

  override refreshModels(): Promise<ModelCatalog> {
    return this.catalogOf(this.catalog.refresh());
  }

  private async catalogOf(pending: Promise<AntigravityListing>): Promise<ModelCatalog> {
    const { source, descriptors } = await pending;
    return {
      provider: this.id,
      formats: this.formats,
      source,
      models: descriptors.map((d) => {
        const limits = advertisedLimits(d);
        return {
          address: { provider: this.id, model: d.wireId },
          displayName: d.displayName,
          ...(limits !== undefined ? { contextWindow: limits.context, maxOutputTokens: limits.output } : {}),
          details: descriptorDetails(d),
        };
      }),
    };
  }

  async passthrough(model: string, request: RawRequest): Promise<HttpResponse> {
    const method = geminiMethod(request.path);
    if (method === undefined) throw new InvalidRequestError(`${this.id} has no native route ${request.path}`);
    if (method === "countTokens") throw new UnsupportedFeatureError(["countTokens"], `${this.id} (cloudcode-pa has no token-count endpoint)`);
    const descriptor = await this.catalog.descriptor(model);
    if (descriptor === undefined) throw new UnknownModelError(`${this.id}/${model}`);
    const body = parseJsonBody(request.body);
    const prepared = prepareGeminiRequest(body, descriptor, { lossy: request.lossy, signatures: await this.native.signatures() });
    const headers: Record<string, string> = {};
    if (prepared.dropped.length > 0) headers[DROPPED_HEADER] = prepared.dropped.join(",");
    const responses = this.native.generate({ model: descriptor, prepared, signal: request.signal });

    if (method === "generateContent") {
      const all: GeminiResponse[] = [];
      for await (const response of responses) all.push(response);
      if (all.length === 0) throw emptyStream();
      this.logger.info(`${this.id}: generateContent model=${model} -> ${all.length} upstream responses merged`);
      return { status: 200, headers: { "content-type": "application/json", ...headers }, body: bodyOf(JSON.stringify(applyReverseAliases(aggregateResponses(all)))) };
    }

    const sse = request.query["alt"] === "sse";
    const iterator = responses[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) throw emptyStream();
    this.logger.info(`${this.id}: streamGenerateContent model=${model} (${sse ? "sse" : "json"}) first response received`);
    return { status: 200, headers: { "content-type": sse ? "text/event-stream" : "application/json", ...headers }, body: this.frames(first.value, iterator, sse, model) };
  }

  private async *frames(first: GeminiResponse, rest: AsyncIterator<GeminiResponse>, sse: boolean, model: string): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    let count = 0;
    // The streamed reverse edge: one rename buffer per stream (held here, never global), flushed per frame so
    // frame boundaries never shift; whole tokens are already restored per response upstream (AntigravityNative).
    let reverseBuffer = "";
    const renameFrame = (text: string): string => {
      const step = reverseStreamChunk(reverseBuffer, text);
      reverseBuffer = step.buffer;
      const tail = flushReverseBuffer(reverseBuffer);
      reverseBuffer = "";
      return step.emit + tail;
    };
    const frame = (value: unknown) => renameFrame(sse ? `data: ${JSON.stringify(value)}\r\n\r\n` : `${count++ > 0 ? ",\r\n" : "["}${JSON.stringify(value)}`);
    try {
      yield encoder.encode(frame(first));
      for (;;) {
        const next = await rest.next();
        if (next.done === true) break;
        yield encoder.encode(frame(next.value));
      }
    } catch (error) {
      this.logger.warn(`${this.id}: stream failed after the first byte (model=${model}): ${errorMessage(error)}`);
      yield encoder.encode(frame(googleErrorEnvelope(asProxyError(error))));
    } finally {
      await rest.return?.();
    }
    if (!sse) yield encoder.encode("]");
  }
}
