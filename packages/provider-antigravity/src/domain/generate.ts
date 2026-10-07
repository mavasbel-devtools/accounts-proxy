// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/RequestTransformService.ts (blob 1db1f243) and the
// ChatRequest/ChatChunk/StreamEnvelope shapes of domain/ports/{inbound,outbound}/index.ts. Pure: the durable
// thoughtSignature store is reached through the `onSignature` hook; `warn` reports dropped unsigned calls.
// Wire laws kept: 5 sanitized tools, 6 thoughtSignature on the part + unsigned Gemini replay dropped, 7 functionResponse
// in MODEL-role contents, 8 content-free messages dropped, 12 trailing assistants stripped AFTER the unsigned drop,
// captured request key order (contents, systemInstruction, tools, toolConfig, labels, generationConfig, sessionId).
import type { TrajectoryLabels } from "@inference-router/provider-antigravity/domain/trajectory.ts";

export type ToolSpec = { readonly name: string; readonly description?: string; readonly parameters?: Readonly<Record<string, unknown>> };
export type ToolCall = { readonly id: string; readonly name: string; readonly arguments: string };
export type ChatMessage = {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly images?: readonly { readonly mimeType: string; readonly base64: string }[];
};
export type ChatRequest = {
  readonly modelWireId: string;
  readonly messages: readonly ChatMessage[];
  readonly maxOutputTokens?: number;
  readonly thinkingBudget?: number;
  readonly tools?: readonly ToolSpec[];
  readonly modelEnum?: string;
};
export type ChatUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly thoughtTokens?: number;
  readonly cachedPromptTokens?: number;
};
export type ChatChunk = {
  readonly deltaText?: string;
  readonly thoughtText?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly finishReason?: string;
  readonly usage?: ChatUsage;
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

export type GenerateContentPart = {
  text?: string;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response?: Record<string, unknown> };
};
export type GenerateBody = {
  contents: Array<{ role: string; parts: GenerateContentPart[] }>;
  systemInstruction?: { role: "user"; parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
  toolConfig?: unknown;
  labels?: TrajectoryLabels;
  generationConfig?: Record<string, unknown>;
  sessionId?: string;
};

const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "propertyOrdering"]);

export function sanitizeSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(sanitizeSchema) as unknown as Record<string, unknown>;
  if (node === null || typeof node !== "object") return node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) props[name] = sanitizeSchema(sub);
      out[k] = props;
    } else {
      out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : sanitizeSchema(v);
    }
  }
  return out;
}

export function toWireTools(tools: readonly ToolSpec[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: sanitizeSchema(t.parameters) } : {}),
      })),
    },
  ];
}

function hasContent(m: ChatMessage): boolean {
  if (m.role === "tool") return true;
  if ((m.toolCalls?.length ?? 0) > 0) return true;
  if ((m.images?.length ?? 0) > 0) return true;
  return m.text.trim().length > 0;
}

const isGeminiFamily = (wireId: string): boolean => wireId.toLowerCase().startsWith("gemini");

function buildGenerationConfig(req: ChatRequest): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {};
  if (req.maxOutputTokens !== undefined) cfg["maxOutputTokens"] = req.maxOutputTokens;
  if (req.thinkingBudget !== undefined) cfg["thinkingConfig"] = { includeThoughts: true, thinkingBudget: req.thinkingBudget };
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

export type GenerateHooks = {
  readonly onSignature?: (callId: string, signature: string) => void;
  readonly warn?: (message: string) => void;
};

export class GenerateCodec {
  private readonly signatures = new Map<string, string>();

  constructor(
    initialSignatures: Readonly<Record<string, string>> = {},
    private readonly hooks: GenerateHooks = {},
  ) {
    for (const [id, signature] of Object.entries(initialSignatures)) this.signatures.set(id, signature);
  }

  toGenerateBody(req: ChatRequest, opts: { readonly labels: TrajectoryLabels; readonly sessionId?: string }): GenerateBody {
    const system: ChatMessage[] = [];
    const turns: ChatMessage[] = [];
    for (const m of req.messages) if (hasContent(m)) (m.role === "system" ? system : turns).push(m);
    this.dropUnsignedCalls(turns, req.modelWireId);
    while (turns.length > 0 && turns[turns.length - 1]!.role === "assistant") turns.pop();
    const genCfg = buildGenerationConfig(req);
    const wireTools = toWireTools(req.tools ?? []);
    return {
      contents: turns.map((m) => this.toContent(m)),
      ...(system.length > 0 ? { systemInstruction: { role: "user" as const, parts: system.map((m) => ({ text: m.text })) } } : {}),
      ...(wireTools.length > 0 ? { tools: wireTools, toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : {}),
      labels: opts.labels,
      ...(genCfg !== undefined ? { generationConfig: genCfg } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    };
  }

  private dropUnsignedCalls(turns: ChatMessage[], modelWireId: string): void {
    if (!isGeminiFamily(modelWireId)) return;
    const unsigned = new Set<string>();
    for (const m of turns) {
      for (const call of m.toolCalls ?? []) {
        if (this.signatures.has(call.id)) continue;
        unsigned.add(call.id);
        this.hooks.warn?.(`dropping replayed function call ${call.id} (${call.name}): no cached thoughtSignature (upstream requires it)`);
      }
    }
    if (unsigned.size === 0) return;
    const kept: ChatMessage[] = [];
    for (const m of turns) {
      if (m.role === "tool") {
        if (m.toolCallId !== undefined && unsigned.has(m.toolCallId)) continue;
        kept.push(m);
        continue;
      }
      const calls = m.toolCalls ?? [];
      const remaining = calls.filter((c) => !unsigned.has(c.id));
      if (remaining.length === calls.length) {
        kept.push(m);
        continue;
      }
      const cleaned: ChatMessage = { ...m, toolCalls: remaining };
      if (hasContent(cleaned)) kept.push(cleaned);
    }
    turns.length = 0;
    turns.push(...kept);
  }

  private toContent(m: ChatMessage): { role: string; parts: GenerateContentPart[] } {
    if (m.role === "tool") {
      return {
        role: "model",
        parts: [
          {
            functionResponse: {
              ...(m.toolCallId !== undefined ? { id: m.toolCallId } : {}),
              name: m.toolName ?? m.toolCallId ?? "",
              response: { output: m.text },
            },
          },
        ],
      };
    }
    const parts: GenerateContentPart[] = [];
    for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    if (m.text.trim().length > 0) parts.push({ text: m.text });
    for (const call of m.toolCalls ?? []) {
      let args: Record<string, unknown>;
      try {
        args = call.arguments === "" ? {} : (JSON.parse(call.arguments) as Record<string, unknown>);
      } catch {
        args = {};
      }
      const signature = this.signatures.get(call.id);
      parts.push({ functionCall: { id: call.id, name: call.name, args }, ...(signature !== undefined ? { thoughtSignature: signature } : {}) });
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  }

  envelopeToChunk(env: StreamEnvelope): ChatChunk | undefined {
    const resp = env.response;
    if (!resp) return undefined;
    const cand = resp.candidates?.[0];
    let deltaText: string | undefined;
    let thoughtText: string | undefined;
    let toolCalls: ToolCall[] | undefined;
    for (const part of cand?.content?.parts ?? []) {
      if (part.functionCall !== undefined) {
        const fc = part.functionCall;
        const id = fc.id ?? `${fc.name}-${toolCalls?.length ?? 0}`;
        if (part.thoughtSignature !== undefined) {
          this.signatures.set(id, part.thoughtSignature);
          this.hooks.onSignature?.(id, part.thoughtSignature);
        }
        toolCalls = toolCalls ?? [];
        toolCalls.push({ id, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) });
      } else if (part.thought === true && part.text) thoughtText = (thoughtText ?? "") + part.text;
      else if (part.text) deltaText = (deltaText ?? "") + part.text;
    }
    return {
      ...(deltaText !== undefined ? { deltaText } : {}),
      ...(thoughtText !== undefined ? { thoughtText } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(cand?.finishReason !== undefined ? { finishReason: cand.finishReason } : {}),
      ...usageFrom(resp),
    };
  }
}

export function usageFrom(resp: NonNullable<StreamEnvelope["response"]>): { usage?: ChatUsage } {
  const u = resp.usageMetadata;
  if (!u) return {};
  return {
    usage: {
      promptTokens: u.promptTokenCount ?? 0,
      completionTokens: u.candidatesTokenCount ?? 0,
      totalTokens: u.totalTokenCount ?? 0,
      ...(u.thoughtsTokenCount !== undefined ? { thoughtTokens: u.thoughtsTokenCount } : {}),
      ...(u.cachedContentTokenCount !== undefined ? { cachedPromptTokens: u.cachedContentTokenCount } : {}),
    },
  };
}

/** Source StreamChatUseCase.hasContent: a chunk worth yielding. */
export function chunkHasContent(c: ChatChunk): boolean {
  return c.deltaText !== undefined || c.thoughtText !== undefined || c.finishReason !== undefined || c.usage !== undefined || c.toolCalls !== undefined;
}
