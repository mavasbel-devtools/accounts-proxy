// Canonical content parts: the union every dialect decodes into and every provider encodes from.
import type { JsonObject } from "../json.ts";
import type { ProviderId } from "../models.ts";

export type MediaSource =
  | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly type: "url"; readonly url: string };

export type TextPart = { readonly kind: "text"; readonly text: string };
export type ImagePart = { readonly kind: "image"; readonly source: MediaSource };
export type DocumentPart = { readonly kind: "document"; readonly source: MediaSource; readonly title?: string };

export type ToolCallPart = {
  readonly kind: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
};

export type ToolResultPart = {
  readonly kind: "tool_result";
  readonly callId: string;
  readonly content: readonly (TextPart | ImagePart)[];
  readonly isError: boolean;
};

/**
 * Model reasoning. `signature` is an opaque provider-issued token (Anthropic thinking signature, Gemini
 * thoughtSignature) that only the issuing provider (`origin`) can verify; it is never valid elsewhere.
 */
export type ThinkingPart = {
  readonly kind: "thinking";
  readonly text: string;
  readonly signature?: string;
  readonly origin?: ProviderId;
};

export type Part = TextPart | ImagePart | DocumentPart | ToolCallPart | ToolResultPart | ThinkingPart;
export type PartKind = Part["kind"];
