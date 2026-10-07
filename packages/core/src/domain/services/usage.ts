import type { Usage } from "@inference-router/core/domain/canonical/events.ts";

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Combine a later usage report into an earlier one. Providers report usage cumulatively (Anthropic
 * message_start then message_delta; Gemini on every chunk), so a defined later value REPLACES the earlier one —
 * values are never summed. A field absent from the later report keeps its earlier value.
 */
export type UsageReport = { readonly [K in keyof Usage]?: Usage[K] | undefined };

export function mergeUsage(earlier: Usage, later: UsageReport): Usage {
  const merged: { -readonly [K in keyof Usage]: Usage[K] } = { ...earlier };
  for (const key of Object.keys(later) as (keyof Usage)[]) {
    const value = later[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
