// Feature detection and the strict/lossy translation policy (plan D3).
// A provider declares the features it can carry (its capability set, written only from P0-E3 measurements).
// `negotiate` compares a request against it: strict → UnsupportedFeatureError; lossy → droppable features are
// removed and reported, non-droppable ones still fail (dropping them would change what the request means).
import type { CanonicalRequest, Message, TranslationPolicy } from "@inference-router/core/domain/canonical/request.ts";
import type { Part } from "@inference-router/core/domain/canonical/parts.ts";
import { UnsupportedFeatureError } from "@inference-router/core/domain/errors.ts";

export type Feature =
  | "system"
  | "images"
  | "documents"
  | "tools"
  | "tool_choice_none"
  | "tool_choice_required"
  | "tool_choice_named"
  | "parallel_tool_calls_disabled"
  | "thinking"
  | "foreign_thinking_signatures"
  | "temperature"
  | "top_p"
  | "top_k"
  | "stop_sequences";

/** Features whose removal leaves the conversation semantically intact apart from the dropped hint itself. */
export const DROPPABLE: ReadonlySet<Feature> = new Set<Feature>([
  "images",
  "documents",
  "thinking",
  "foreign_thinking_signatures",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "parallel_tool_calls_disabled",
]);

const hasPart = (messages: readonly Message[], test: (part: Part) => boolean): boolean =>
  messages.some((m) => m.parts.some((p) => test(p) || (p.kind === "tool_result" && p.content.some(test))));

export function featuresOf(request: CanonicalRequest): Set<Feature> {
  const found = new Set<Feature>();
  const target = request.model.provider;
  if (request.system.length > 0) found.add("system");
  if (hasPart(request.messages, (p) => p.kind === "image")) found.add("images");
  if (hasPart(request.messages, (p) => p.kind === "document")) found.add("documents");
  if (request.tools.length > 0 || hasPart(request.messages, (p) => p.kind === "tool_call" || p.kind === "tool_result")) {
    found.add("tools");
  }
  if (request.toolChoice?.mode === "none") found.add("tool_choice_none");
  if (request.toolChoice?.mode === "required") found.add("tool_choice_required");
  if (request.toolChoice?.mode === "tool") found.add("tool_choice_named");
  if (request.parallelToolCalls === false) found.add("parallel_tool_calls_disabled");
  if (request.thinking !== undefined && request.thinking.mode !== "off") found.add("thinking");
  if (hasPart(request.messages, (p) => p.kind === "thinking" && p.signature !== undefined && p.origin !== target)) {
    found.add("foreign_thinking_signatures");
  }
  if (request.params.temperature !== undefined) found.add("temperature");
  if (request.params.topP !== undefined) found.add("top_p");
  if (request.params.topK !== undefined) found.add("top_k");
  if (request.params.stopSequences !== undefined && request.params.stopSequences.length > 0) found.add("stop_sequences");
  return found;
}

export type Negotiated = { readonly request: CanonicalRequest; readonly dropped: readonly Feature[] };

export function negotiate(
  request: CanonicalRequest,
  supported: ReadonlySet<Feature>,
  policy: TranslationPolicy,
  target: string,
): Negotiated {
  const missing = [...featuresOf(request)].filter((f) => !supported.has(f)).sort();
  if (missing.length === 0) return { request, dropped: [] };
  const blocking = policy.lossy ? missing.filter((f) => !DROPPABLE.has(f)) : missing;
  if (blocking.length > 0) throw new UnsupportedFeatureError(blocking, target);
  return { request: missing.reduce(drop, request), dropped: missing };
}

function mapParts(request: CanonicalRequest, keep: (part: Part) => Part | undefined): CanonicalRequest {
  const messages = request.messages.map((m) => ({
    role: m.role,
    parts: m.parts.flatMap((p): Part[] => {
      if (p.kind === "tool_result") {
        const content = p.content.flatMap((c) => {
          const kept = keep(c);
          return kept && (kept.kind === "text" || kept.kind === "image") ? [kept] : [];
        });
        return [{ ...p, content }];
      }
      const kept = keep(p);
      return kept ? [kept] : [];
    }),
  }));
  return { ...request, messages: messages.filter((m) => m.parts.length > 0) };
}

/** Remove one droppable feature from the request. Only called with features in DROPPABLE. */
export function drop(request: CanonicalRequest, feature: Feature): CanonicalRequest {
  const { temperature, topP, topK, stopSequences, ...params } = request.params;
  switch (feature) {
    case "images":
      return mapParts(request, (p) => (p.kind === "image" ? undefined : p));
    case "documents":
      return mapParts(request, (p) => (p.kind === "document" ? undefined : p));
    case "thinking": {
      const { thinking: _thinking, ...rest } = request;
      return rest;
    }
    case "foreign_thinking_signatures":
      return mapParts(request, (p) =>
        p.kind === "thinking" && p.signature !== undefined && p.origin !== request.model.provider ? undefined : p,
      );
    case "temperature":
      return { ...request, params: withParams(params, { topP, topK, stopSequences }) };
    case "top_p":
      return { ...request, params: withParams(params, { temperature, topK, stopSequences }) };
    case "top_k":
      return { ...request, params: withParams(params, { temperature, topP, stopSequences }) };
    case "stop_sequences":
      return { ...request, params: withParams(params, { temperature, topP, topK }) };
    case "parallel_tool_calls_disabled": {
      const { parallelToolCalls: _parallel, ...rest } = request;
      return rest;
    }
    default:
      throw new Error(`feature ${feature} is not droppable`);
  }
}

function withParams(
  base: CanonicalRequest["params"],
  extra: { temperature?: number | undefined; topP?: number | undefined; topK?: number | undefined; stopSequences?: readonly string[] | undefined },
): CanonicalRequest["params"] {
  const out: { -readonly [K in keyof CanonicalRequest["params"]]: CanonicalRequest["params"][K] } = { ...base };
  if (extra.temperature !== undefined) out.temperature = extra.temperature;
  if (extra.topP !== undefined) out.topP = extra.topP;
  if (extra.topK !== undefined) out.topK = extra.topK;
  if (extra.stopSequences !== undefined) out.stopSequences = extra.stopSequences;
  return out;
}
