// Canonical streaming events. A provider emits them; a dialect codec encodes them for the client.
import type { RouterErrorCode } from "../errors.ts";

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
};

export type FinishReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "content_filter"
  | "refusal"
  | "other";

export type BlockStart =
  | { readonly kind: "text" }
  | { readonly kind: "thinking" }
  | { readonly kind: "tool_call"; readonly id: string; readonly name: string };

export type CanonicalEvent =
  | { readonly type: "message_start"; readonly id: string; readonly model: string }
  | { readonly type: "block_start"; readonly index: number; readonly block: BlockStart }
  | { readonly type: "text_delta"; readonly index: number; readonly text: string }
  | { readonly type: "thinking_delta"; readonly index: number; readonly text: string }
  | { readonly type: "thinking_signature"; readonly index: number; readonly signature: string }
  | { readonly type: "tool_input_delta"; readonly index: number; readonly json: string }
  | { readonly type: "block_stop"; readonly index: number }
  | { readonly type: "usage"; readonly usage: Usage }
  /** `raw` is the provider's own finish/stop reason string, kept verbatim for diagnostics. */
  | { readonly type: "finish"; readonly reason: FinishReason; readonly raw: string }
  | { readonly type: "error"; readonly code: RouterErrorCode; readonly message: string };

export type CanonicalEventType = CanonicalEvent["type"];
