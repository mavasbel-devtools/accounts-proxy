// Rules O2 and P2 (docs/reference/2026-10-16-01-38-model-catalog-rules.md, pi rules): the format a client uses for a model, and the provider display names every client configuration shows.
import type { DetailedModel } from "@accounts-proxy/core/domain/model-details.ts";
import type { ProviderId, WireFormat } from "@accounts-proxy/core/domain/models.ts";

export const AISDK_FORMAT: Readonly<Record<string, WireFormat>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-chat",
  "@ai-sdk/google": "gemini",
  "@openrouter/ai-sdk-provider": "openai-chat",
};

export type ChosenFormat = { readonly format: WireFormat; readonly aiSdkPackage?: string };

export function chooseFormat(model: DetailedModel): ChosenFormat | undefined {
  const pkg = model.aiSdkPackage;
  if (pkg !== undefined) {
    const format = AISDK_FORMAT[pkg];
    if (format !== undefined && model.formats.includes(format)) return { format, aiSdkPackage: pkg };
  }
  const first = model.formats[0];
  return first === undefined ? undefined : { format: first };
}

export const PROVIDER_DISPLAY_NAMES: Readonly<Record<ProviderId, string>> = {
  claude: "Claude",
  antigravity: "Antigravity",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "cheaper-inference": "Cheaper Inference",
};
