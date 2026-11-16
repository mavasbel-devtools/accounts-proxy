// The pi thinking rules P4 and the thinking half of P5, over the live catalog's real shapes (2026-11-15).
import { describe, expect, test } from "bun:test";
import type { DetailedModel } from "@accounts-proxy/core/domain/model-details.ts";
import { piThinking } from "@accounts-proxy/dialect-pi/adapters/inbound/pi-thinking.ts";

const model = (over: Partial<DetailedModel> & { provider: DetailedModel["provider"]; model: string }): DetailedModel => ({
  id: `${over.provider}/${over.model}`,
  name: over.model,
  formats: [],
  sources: {},
  ...over,
});

// Live shapes from $TMPDIR/opencode/2026-11-15-23-52-pi-compatibility/catalog.json.
const opus55 = model({
  provider: "claude",
  model: "claude-opus-5-5",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }, { type: "budget_tokens", min: 1024 }],
  aiSdkPackage: "@ai-sdk/anthropic",
  formats: ["anthropic-messages"],
});
const opus46 = model({
  provider: "claude",
  model: "claude-opus-4-6",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "max"] }, { type: "budget_tokens", min: 1024 }],
  formats: ["anthropic-messages"],
});
const haiku = model({
  provider: "claude",
  model: "claude-haiku-4-5-20251001",
  reasoning: false,
  reasoningOptions: [{ type: "budget_tokens", min: 1024 }],
  aiSdkPackage: "@ai-sdk/anthropic",
  formats: ["anthropic-messages"],
});
const flashLite = model({
  provider: "opencode",
  model: "gemini-3.5-flash-lite",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  aiSdkPackage: "@ai-sdk/google",
  formats: ["gemini"],
});
const sol56 = model({
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
  aiSdkPackage: "@ai-sdk/openai",
  formats: ["openai-responses"],
});
const sol61 = model({
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  aiSdkPackage: "@ai-sdk/openai",
  formats: ["openai-responses"],
});
const antigravityFlash = model({
  provider: "antigravity",
  model: "gemini-3.5-flash-lite",
  reasoning: true,
  reasoningOptions: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
  formats: ["gemini"],
});
const toggleOnly = model({
  provider: "openrouter",
  model: "kt/midm-k-3.0-pro",
  reasoning: true,
  reasoningOptions: [{ type: "toggle" }],
  aiSdkPackage: "@openrouter/ai-sdk-provider",
  formats: ["openai-chat", "openai-responses", "anthropic-messages"],
});
const noOptions = model({
  provider: "openrouter",
  model: "unbiased/pareto-26.10",
  reasoning: false,
  aiSdkPackage: "@openrouter/ai-sdk-provider",
  formats: ["openai-chat", "openai-responses", "anthropic-messages"],
});

describe("piThinking", () => {
  test("an effort model on anthropic-messages maps each level and forces adaptive thinking [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(piThinking(opus55, "anthropic-messages")).toEqual({
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true },
    });
  });

  test("a level the catalog does not list is null [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const out = piThinking(opus46, "anthropic-messages");
    expect(out.thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" });
    expect(out.compat).toEqual({ forceAdaptiveThinking: true });
  });

  test("a budget-only model with reasoning false still reasons but gets no map [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(piThinking(haiku, "anthropic-messages")).toEqual({ reasoning: true });
  });

  test("a gemini effort model maps minimal through high and nulls xhigh and max [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(piThinking(flashLite, "google-generative-ai")).toEqual({
      reasoning: true,
      thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    });
  });

  test("listed xhigh and max are still null on google-generative-ai [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    const out = piThinking(sol56, "google-generative-ai");
    expect(out.thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null, off: "none" });
    expect(out.compat).toBeUndefined();
  });

  test("the openai provider maps off to none when none is listed [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    const out = piThinking(sol56, "openai-responses");
    expect(out.reasoning).toBe(true);
    expect(out.thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", off: "none" });
    expect(out.compat).toBeUndefined();
  });

  test("the openai provider maps off to null when none is not listed [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(piThinking(sol61, "openai-responses").thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
      off: null,
    });
  });

  test("a non-openai provider leaves off unset [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(piThinking(opus55, "anthropic-messages").thinkingLevelMap).not.toHaveProperty("off");
    expect(piThinking(flashLite, "google-generative-ai").thinkingLevelMap).not.toHaveProperty("off");
  });

  test("an antigravity effort model keeps reasoning false with no map: the effort is ignored [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(piThinking(antigravityFlash, "google-generative-ai")).toEqual({ reasoning: false });
  });

  test("a toggle-only model reasons with no map on a non-anthropic api [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(piThinking(toggleOnly, "openai-completions")).toEqual({ reasoning: true });
  });

  test("a toggle-only model on anthropic-messages gets no adaptive compat without an effort option [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(piThinking(toggleOnly, "anthropic-messages")).toEqual({ reasoning: true });
  });

  test("a model with no options does not reason [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(piThinking(noOptions, "openai-completions")).toEqual({ reasoning: false });
  });

  test("a model with an empty option list does not reason [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(piThinking(model({ provider: "openrouter", model: "m", reasoning: false, reasoningOptions: [] }), "openai-completions")).toEqual({ reasoning: false });
  });
});
