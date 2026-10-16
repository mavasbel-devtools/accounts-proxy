// The conversation and response-envelope shapes of opencode-antigravity-auth @ 5c6f7c2
// domain/ports/{inbound,outbound}/index.ts, used by the native Gemini cell (native-gemini.ts), the trajectory and the
// cloudcode-pa client. The plugin's chat codec (RequestTransformService.ts) left with the translated cells (P5
// cancelled, plan 2026-10-16 C1); its wire laws hold in native-gemini.ts.

export type ToolCall = { readonly id: string; readonly name: string; readonly arguments: string };
export type ChatMessage = {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly images?: readonly { readonly mimeType: string; readonly base64: string }[];
};

export type EnvelopePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response?: Record<string, unknown> };
};
export type StreamEnvelope = {
  response?: {
    candidates?: Array<{ content?: { role?: string; parts?: EnvelopePart[] }; finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
  metadata?: Record<string, unknown>;
};
