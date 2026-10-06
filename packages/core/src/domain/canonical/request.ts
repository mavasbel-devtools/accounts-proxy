import type { JsonObject } from "../json.ts";
import type { ModelAddress } from "../models.ts";
import type { Part, TextPart } from "./parts.ts";

export type Role = "user" | "assistant";
export type Message = { readonly role: Role; readonly parts: readonly Part[] };

export type ToolSpec = {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema of the tool input, as given by the client. */
  readonly parameters: JsonObject;
};

export type ToolChoice =
  | { readonly mode: "auto" }
  | { readonly mode: "none" }
  | { readonly mode: "required" }
  | { readonly mode: "tool"; readonly name: string };

export type GenerationParams = {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stopSequences?: readonly string[];
};

export type ThinkingIntent =
  | { readonly mode: "off" }
  | { readonly mode: "budget"; readonly budgetTokens: number }
  | { readonly mode: "adaptive" }
  | { readonly mode: "effort"; readonly effort: string };

export type CanonicalRequest = {
  readonly model: ModelAddress;
  readonly system: readonly TextPart[];
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly params: GenerationParams;
  readonly thinking?: ThinkingIntent;
  readonly stream: boolean;
};

/** Strict (default): an untransportable feature is a 400. Lossy: droppable features are removed and reported. */
export type TranslationPolicy = { readonly lossy: boolean };
