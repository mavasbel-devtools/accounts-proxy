// The shared format choice and provider names (rules O2 and P2).
import { describe, expect, test } from "bun:test";
import { AISDK_FORMAT, chooseFormat, PROVIDER_DISPLAY_NAMES } from "@accounts-proxy/core/domain/client-connection.ts";
import type { DetailedModel } from "@accounts-proxy/core/domain/model-details.ts";
import type { WireFormat } from "@accounts-proxy/core/domain/models.ts";

const model = (over: Partial<DetailedModel> = {}): DetailedModel => ({
  id: "claude/m",
  provider: "claude",
  model: "m",
  name: "m",
  formats: [],
  sources: {},
  ...over,
});

describe("chooseFormat", () => {
  test("reference package accepted when the model serves its format [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(chooseFormat(model({ formats: ["anthropic-messages"], aiSdkPackage: "@ai-sdk/anthropic" }))).toEqual({
      format: "anthropic-messages",
      aiSdkPackage: "@ai-sdk/anthropic",
    });
  });

  test("reference package whose format the model lacks falls back to the first format [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(chooseFormat(model({ formats: ["gemini"], aiSdkPackage: "@ai-sdk/anthropic" }))).toEqual({ format: "gemini" });
  });

  test("unknown package falls back to the first format [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(chooseFormat(model({ formats: ["openai-chat"], aiSdkPackage: "@ai-sdk/unknown" }))).toEqual({ format: "openai-chat" });
  });

  test("no package falls back to the first format [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(chooseFormat(model({ formats: ["openai-responses"] }))).toEqual({ format: "openai-responses" });
  });

  test("no formats is undefined [feature=pi-config use-case=uc-pi-1 tier=unit polarity=negative]", () => {
    expect(chooseFormat(model({ formats: [] }))).toBeUndefined();
    expect(chooseFormat(model({ formats: [], aiSdkPackage: "@ai-sdk/anthropic" }))).toBeUndefined();
    expect(chooseFormat(model({ formats: [], aiSdkPackage: "@ai-sdk/unknown" }))).toBeUndefined();
  });

  test("every AISDK_FORMAT row is chosen when the model serves it [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    const rows: Readonly<Record<string, WireFormat>> = AISDK_FORMAT;
    expect(Object.keys(rows)).toEqual(["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/google", "@openrouter/ai-sdk-provider"]);
    for (const [pkg, format] of Object.entries(rows)) {
      expect(chooseFormat(model({ formats: [format], aiSdkPackage: pkg }))).toEqual({ format, aiSdkPackage: pkg });
    }
  });

  test("the 7 provider display names [feature=pi-config use-case=uc-pi-1 tier=unit polarity=positive]", () => {
    expect(PROVIDER_DISPLAY_NAMES).toEqual({
      claude: "Claude",
      antigravity: "Antigravity",
      openai: "OpenAI",
      openrouter: "OpenRouter",
      opencode: "OpenCode Zen",
      "opencode-go": "OpenCode Go",
      "cheaper-inference": "Cheaper Inference",
    });
  });
});
