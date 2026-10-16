// opencode's model variants for the packages the router's configuration uses (plan 2026-10-16 rule O4). Port of
// opencode v2.0.26 (9b4ec5714d) packages/core/src/variant.ts `resolve` with the protocols of
// @opencode/ai/providers/{anthropic, openai, openai-compatible, google, openrouter}; vendored byte-identical in
// tests/reference/plugin-9b4ec5714d/core/src/variant.ts, its cases in core/test/variant.test.ts. The router's
// openai-compatible models are never NVIDIA's (`openaiCompatible` → `openaiChat`). An effort option always carries its
// values here (models.dev `reasoning_options`, `ReasoningOption`), so variant.ts's default effort lists never apply.
import type { ReasoningOption } from "@inference-router/core/domain/model-details.ts";

export const ANTHROPIC_PACKAGE = "@opencode/ai/providers/anthropic";
export const OPENAI_PACKAGE = "@opencode/ai/providers/openai";
export const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const GOOGLE_PACKAGE = "@opencode/ai/providers/google";
export const OPENROUTER_PACKAGE = "@opencode/ai/providers/openrouter";
/** The connection packages the router's configuration writes (rule O2); each has its protocol below. */
export type OpencodePackage = typeof ANTHROPIC_PACKAGE | typeof OPENAI_PACKAGE | typeof OPENAI_COMPATIBLE_PACKAGE | typeof GOOGLE_PACKAGE | typeof OPENROUTER_PACKAGE;

type Json = Readonly<Record<string, unknown>>;
export type Variant = { readonly id: string; readonly settings?: Json; readonly body?: Json };
type Overlay = Omit<Variant, "id">;
/** What the protocols read of a model: its id, package and output limit (opencode's default output is 32 000). */
export type VariantModel = { readonly modelID: string; readonly package: OpencodePackage; readonly outputLimit: number };
type Support = { readonly type: "effort"; readonly values: readonly string[] } | { readonly type: "toggle" } | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };
type Protocol = (model: VariantModel, support: Support) => Variant[];

const ENCRYPTED_REASONING = ["reasoning.encrypted_content"];
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" };
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000;

const variant = (id: string, overlay: Overlay): Variant => ({ id, ...overlay });
const efforts = (values: readonly string[], spell: (effort: string) => Overlay): Variant[] => values.map((effort) => variant(effort, spell(effort)));
const toggle = (off: Overlay, on: Overlay): Variant[] => [variant("none", off), variant("thinking", on)];

function budgets(model: VariantModel, support: Extract<Support, { type: "budget_tokens" }>, spell: (tokens: number) => Overlay, ceiling = model.outputLimit): Variant[] {
  const maximum = Math.min(support.max ?? ceiling - 1, model.outputLimit - 1, ceiling - 1);
  if (maximum <= 0) return [];
  const high = Math.min(Math.max(support.min ?? 0, Math.floor((maximum + 1) / 2)), maximum);
  return [variant("high", spell(high)), variant("max", spell(maximum))];
}

function claudeInfo(model: VariantModel) {
  const id = model.modelID;
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id);
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id);
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase();
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1]);
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0);
  return {
    family,
    major,
    minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === "fable" || family === "mythos" || id.toLowerCase().includes("mythos-preview"),
  };
}

function manualThinking(model: VariantModel): Overlay | undefined {
  const tokens = Math.min(16_000, model.outputLimit - 1);
  if (tokens < 1024) return undefined;
  return { settings: { thinking: { type: "enabled", budgetTokens: tokens } } };
}

const openaiChat: Protocol = (_, support) => {
  if (support.type !== "effort") return [];
  return efforts(support.values, (effort) => ({ settings: { reasoningEffort: effort } }));
};

const responsesEffort = (effort: string): Overlay => ({ settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ENCRYPTED_REASONING } });

const openaiResponses: Protocol = (_, support) => {
  if (support.type !== "effort") return [];
  return efforts(support.values, responsesEffort);
};

const anthropicMessages: Protocol = (model, support) => {
  const info = claudeInfo(model);
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5;
  switch (support.type) {
    case "effort": {
      if (info.manual && !opus45) return anthropicMessages(model, { type: "budget_tokens", min: 1024 });
      const thinking = opus45 ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } };
      if (!thinking) return [];
      const values = support.values.filter((effort) => !info.always || effort !== "none");
      return efforts(values, (effort) => (effort === "none" ? { settings: { thinking: { type: "disabled" } } } : { settings: { ...thinking.settings, effort } }));
    }
    case "toggle": {
      if (info.always) return [];
      const thinking = info.manual ? manualThinking(model) : { settings: { thinking: ADAPTIVE_THINKING } };
      if (!thinking) return [];
      return toggle({ settings: { thinking: { type: "disabled" } } }, thinking);
    }
    case "budget_tokens":
      return budgets(model, support, (tokens) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } }), ANTHROPIC_OUTPUT_TOKEN_MAX);
  }
};

const gemini: Protocol = (model, support) => {
  switch (support.type) {
    case "effort":
      return efforts(support.values, (effort) => ({ settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } } }));
    case "toggle":
      return toggle({ settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } }, { settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } } });
    case "budget_tokens":
      return budgets(model, support, (tokens) => ({ settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: tokens } } }));
  }
};

const openrouter: Protocol = (model, support) => {
  switch (support.type) {
    case "effort":
      return efforts(support.values, (effort) => ({ settings: { reasoning: { effort } } }));
    case "toggle":
      return toggle({ settings: { reasoning: { enabled: false } } }, { settings: { reasoning: { enabled: true } } });
    case "budget_tokens":
      return budgets(model, support, (tokens) => ({ settings: { reasoning: { max_tokens: tokens } } }));
  }
};

const PROTOCOLS: Readonly<Record<OpencodePackage, Protocol>> = {
  [OPENAI_PACKAGE]: openaiResponses,
  [OPENAI_COMPATIBLE_PACKAGE]: openaiChat,
  [ANTHROPIC_PACKAGE]: anthropicMessages,
  [GOOGLE_PACKAGE]: gemini,
  [OPENROUTER_PACKAGE]: openrouter,
};

/** variant.ts `resolve`: the toggle's `none`, then the effort variants (else the budget ones, else the toggle's). */
export function resolveVariants(model: VariantModel, supports: readonly ReasoningOption[]): Variant[] {
  const protocol = PROTOCOLS[model.package];
  const toggled = supports.some((s) => s.type === "toggle") ? protocol(model, { type: "toggle" }) : [];
  const effort = supports.find((s) => s.type === "effort");
  const budget = supports.find((s) => s.type === "budget_tokens");
  const main = effort ? protocol(model, effort) : budget ? protocol(model, budget) : toggled;
  const variants = [...toggled.filter((v) => v.id === "none"), ...main];
  return variants.filter((v, index) => variants.findIndex((other) => other.id === v.id) === index);
}
