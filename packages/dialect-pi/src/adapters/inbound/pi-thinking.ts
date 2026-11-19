// Rules P4 and the thinking half of P5 (docs/design/2026-11-15-23-52-pi-compatibility-product.md §4): whether a
// model reasons and which thinking level map and compat pi sends for it.
import type { JsonObject } from "@accounts-proxy/core/domain/json.ts";
import type { DetailedModel, ReasoningOption } from "@accounts-proxy/core/domain/model-details.ts";

export type PiApi = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";

const LEVELS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"] = ["minimal", "low", "medium", "high", "xhigh", "max"];

type EffortOption = Extract<ReasoningOption, { readonly type: "effort" }>;

export function piThinking(model: DetailedModel, api: PiApi): { reasoning: boolean; thinkingLevelMap?: JsonObject; compat?: JsonObject } {
  // P5: Antigravity keeps the catalog budget, so pi sends no thinkingConfig.
  if (model.provider === "antigravity") return { reasoning: false };
  // P4: reasoning is true when the catalog says so or lists any reasoning option.
  const reasoning = model.reasoning === true || (model.reasoningOptions ?? []).length > 0;
  const effort: EffortOption | undefined = (model.reasoningOptions ?? []).find((o): o is EffortOption => o.type === "effort");
  // P4: a model with only toggle or budget_tokens options gets no map: pi uses its budgets.
  if (effort === undefined) return { reasoning };
  const values = effort.values;
  const thinkingLevelMap: JsonObject = {};
  for (const level of LEVELS) {
    // P4: each level maps to the same-named effort when the catalog lists it, else null; on google-generative-ai
    // only minimal–high may be strings, so xhigh and max are always null.
    thinkingLevelMap[level] = api === "google-generative-ai" && (level === "xhigh" || level === "max") ? null : values.includes(level) ? level : null;
  }
  // P5: the off level maps to none only for the openai provider when the catalog lists none, else null.
  if (model.provider === "openai") thinkingLevelMap["off"] = values.includes("none") ? "none" : null;
  // P4: an effort option on anthropic-messages forces the adaptive thinking format.
  if (api === "anthropic-messages") return { reasoning, thinkingLevelMap, compat: { forceAdaptiveThinking: true } };
  return { reasoning, thinkingLevelMap };
}
