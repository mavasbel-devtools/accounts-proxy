import type { ChatChunk, ChatMessage, ChatRequest, ToolSpec } from '../../domain/ports/inbound/index.ts'
import type { LoggerPort, SignatureStorePort, StreamEnvelope } from '../../domain/ports/outbound/index.ts'
import type { TrajectoryLabels } from '../../domain/services/TrajectoryStateService.ts'

export interface GenerateContentPart {
  text?: string
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response?: Record<string, unknown> }
}

export interface GenerateContentRequestShape {
  contents: Array<{ role: string; parts: GenerateContentPart[] }>
  systemInstruction?: { role: 'user'; parts: Array<{ text: string }> }
  tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
  toolConfig?: unknown
  labels?: TrajectoryLabels
  generationConfig?: Record<string, unknown>
  /** Signed int64 as its exact decimal STRING (proto int64 → JSON string; TYPE_STRING otherwise). */
  sessionId?: string
}

function buildGenerationConfig(req: ChatRequest): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {}
  if (req.maxOutputTokens !== undefined) cfg['maxOutputTokens'] = req.maxOutputTokens
  if (req.thinkingBudget !== undefined)
    cfg['thinkingConfig'] = { includeThoughts: true, thinkingBudget: req.thinkingBudget }
  return Object.keys(cfg).length > 0 ? cfg : undefined
}

/**
 * OpenAI speaks lowercase JSON-schema type enums and full JSON-Schema
 * vocabulary; the Antigravity wire dialect accepts UPPERCASE types and ONLY a
 * conservative key subset ("Unknown name \"$schema\" / \"exclusiveMinimum\" …
 * Cannot find field" 400s otherwise, proven live via real opencode traffic).
 * Everything outside the whitelist is dropped; types are recased.
 */
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'propertyOrdering'])

function sanitizeSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(sanitizeSchema) as unknown as Record<string, unknown>
  if (node === null || typeof node !== 'object') return node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue
    if (k === 'properties' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Property NAMES are user-defined, not schema keywords — sanitize each
      // VALUE while keeping every key (a plain whitelist here would empty it).
      const props: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) props[name] = sanitizeSchema(sub)
      out[k] = props
    } else {
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : sanitizeSchema(v)
    }
  }
  return out
}

/** Maps host tool specs into the captured `tools:[{functionDeclarations}]` wire shape. */
export function toWireTools(tools: readonly ToolSpec[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
  if (tools.length === 0) return []
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: sanitizeSchema(t.parameters) } : {}),
      })),
    },
  ]
}

/**
 * Anthropic-backed models (claude-*) reject any empty text part with
 * 400 INVALID_ARGUMENT while Gemini tolerates them. Host history routinely
 * contains tool-only / reasoning-only turns that flatten to empty text, so
 * every content-free message is dropped before it can reach the wire —
 * except messages that carry tool traffic, which are structural.
 */
function hasContent(m: ChatMessage): boolean {
  if (m.role === 'tool') return true
  if ((m.toolCalls?.length ?? 0) > 0) return true
  if ((m.images?.length ?? 0) > 0) return true
  return m.text.trim().length > 0
}

/**
 * thoughtSignature (the mandatory-on-replay functionCall sibling) is a
 * Gemini-family protocol feature; claude/gpt-oss models routed through the
 * Antigravity proxy neither emit nor require it. The unsigned-call drop must
 * apply to Gemini models only.
 */
function isGeminiFamily(modelWireId: string): boolean {
  return modelWireId.toLowerCase().startsWith('gemini')
}

function toPartText(m: ChatMessage): { text: string } {
  return { text: m.text }
}/** Pure translation between host chat requests and the captured wire format. */
export interface TransformDeps {
  /** Optional durable thoughtSignature store; loaded at construction, write-through on capture. */
  readonly signaturesStore?: SignatureStorePort
  /** Warns when an unsigned tool call is dropped from a replayed history. */
  readonly logger?: Pick<LoggerPort, 'warn'>
}

export class RequestTransformService {
  /** thoughtSignature per tool-call id, captured from live streams. Upstream
   *  REJECTS replayed functionCall history that lacks the original signature
   *  ("Function call is missing a thought_signature … INVALID_ARGUMENT",
   *  proven live 2026-08-25/2026-09-01), and OpenAI clients cannot round-trip
   *  it, so the transform remembers it on their behalf. */
  private readonly signatures = new Map<string, string>()
  private readonly signaturesStore: SignatureStorePort | undefined
  private readonly logger: Pick<LoggerPort, 'warn'> | undefined

  constructor(deps?: TransformDeps) {
    this.signaturesStore = deps?.signaturesStore
    this.logger = deps?.logger
    if (this.signaturesStore !== undefined) {
      for (const [id, signature] of Object.entries(this.signaturesStore.readAll())) {
        this.signatures.set(id, signature)
      }
    }
  }

  toGenerateBody(
    req: ChatRequest,
    opts: { labels: TrajectoryLabels; sessionId?: string },
  ): GenerateContentRequestShape {
    const system: ChatMessage[] = []
    const turns: ChatMessage[] = []
    for (const m of req.messages) if (hasContent(m)) (m.role === 'system' ? system : turns).push(m)
    // Drop unsigned replayed function calls FIRST, then strip trailing assistants.
    // Ordering matters (live-verified 2026-09-01): dropUnsignedCalls can remove a
    // trailing tool/functionResponse message whose call was unsigned, which would
    // otherwise leave an assistant-with-text as the last wire turn → upstream
    // 400 INVALID_ARGUMENT "Requests ending with a model turn are not supported".
    // Stripping AFTER the drop guarantees the wire can never end on a model turn.
    this.dropUnsignedCalls(turns, req.modelWireId)
    // Anthropic-backed models reject a conversation that ENDS in an assistant
    // message ("assistant message prefill … must end with a user message",
    // live-verified 2026-08-28). opencode's retry path re-sends the failed
    // assistant reply as the last message, which 400'd after our finish-reason
    // fix stopped the stream from looking failed — strip it so the wire always
    // ends on a user (or tool/functionResponse) turn, mirroring the captured IDE.
    while (turns.length > 0 && turns[turns.length - 1]!.role === 'assistant') turns.pop()
    const genCfg = buildGenerationConfig(req)
    const wireTools = toWireTools(req.tools ?? [])
    // Captured request.key ORDER (both eras): contents, systemInstruction, tools,
    // toolConfig, labels, generationConfig, sessionId — preserve it exactly.
    const body: GenerateContentRequestShape = {
      contents: turns.map((m) => this.toContent(m)),
      ...(system.length > 0
        ? { systemInstruction: { role: 'user' as const, parts: system.map(toPartText) } }
        : {}),
      ...(wireTools.length > 0
        ? { tools: wireTools, toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }
        : {}),
      labels: opts.labels,
      ...(genCfg !== undefined ? { generationConfig: genCfg } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    }
    return body
  }

  /**
   * Upstream hard-400s a replayed functionCall that lacks its original
   * thoughtSignature ("Function call is missing a thought_signature …",
   * live-verified 2026-08-25 and reproduced 2026-09-01; a fabricated one is
   * rejected as "Corrupted thought signature."). The signature is captured at
   * generation time, but the model MAY omit it (adaptive behavior) and the
   * in-memory cache can be lost across restarts. When a signature is
   * unavailable the call cannot be replayed at all — drop the call and the
   * tool result that answers it so the request proceeds (200) instead of
   * failing (400).
   *
   * thoughtSignature is a Gemini-family protocol feature ONLY. Anthropic-backed
   * (claude) and OpenAI-backed (gpt-oss) models never emit a signature and the
   * upstream does not require one for them (live-verified: claude tool
   * round-trips succeed with unsigned functionCalls), so the drop is gated to
   * Gemini models — dropping a claude/gpt-oss tool call would corrupt a valid
   * conversation and break agentic tool use.
   */
  private dropUnsignedCalls(turns: ChatMessage[], modelWireId: string): void {
    if (!isGeminiFamily(modelWireId)) return
    const unsigned = new Set<string>()
    for (const m of turns) {
      for (const call of m.toolCalls ?? []) {
        if (this.signatures.has(call.id)) continue
        unsigned.add(call.id)
        this.logger?.warn(
          `dropping replayed function call ${call.id} (${call.name}): no cached thoughtSignature (upstream requires it)`,
        )
      }
    }
    if (unsigned.size === 0) return
    const kept: ChatMessage[] = []
    for (const m of turns) {
      if (m.role === 'tool') {
        if (m.toolCallId !== undefined && unsigned.has(m.toolCallId)) continue
        kept.push(m)
        continue
      }
      const calls = m.toolCalls ?? []
      const remaining = calls.filter((c) => !unsigned.has(c.id))
      if (remaining.length === calls.length) {
        kept.push(m)
        continue
      }
      const cleaned: ChatMessage = { ...m, ...(remaining.length > 0 ? { toolCalls: remaining } : { toolCalls: [] }) }
      if (hasContent(cleaned)) kept.push(cleaned)
    }
    turns.length = 0
    turns.push(...kept)
  }

  /**
   * Capture-proven Antigravity quirk: function responses ride in MODEL-role
   * contents as {id, name, response:{output}} (2026-08-25 capture, gpt-oss
   * trajectory), unlike public Gemini's user-role convention.
   */
  private toContent(m: ChatMessage): { role: string; parts: GenerateContentPart[] } {
    if (m.role === 'tool') {
      return {
        role: 'model',
        parts: [
          {
            functionResponse: {
              ...(m.toolCallId !== undefined ? { id: m.toolCallId } : {}),
              name: m.toolName ?? m.toolCallId ?? '',
              response: { output: m.text },
            },
          },
        ],
      }
    }
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts: GenerateContentPart[] = []
    for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } })
    if (m.text.trim().length > 0) parts.push({ text: m.text })
    for (const call of m.toolCalls ?? []) {
      let args: Record<string, unknown> | undefined
      try {
        args = call.arguments === '' ? {} : (JSON.parse(call.arguments) as Record<string, unknown>)
      } catch {
        args = {}
      }
      const signature = this.signatures.get(call.id)
      parts.push({
        functionCall: { id: call.id, name: call.name, args },
        // Upstream REJECTS replayed calls without the original thought_signature
        // ("missing a thought_signature … INVALID_ARGUMENT", live 2026-08-25);
        // the signature rides ON THE PART, sibling of functionCall — placing it
        // inside functionCall yields "Unknown name thoughtSignature" 400.
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      })
    }
    return { role, parts }
  }

  envelopeToChunk(env: StreamEnvelope): ChatChunk | undefined {
    const resp = env.response
    if (!resp) return undefined
    const cand = resp.candidates?.[0]
    let deltaText: string | undefined
    let thoughtText: string | undefined
    let toolCalls: { id: string; name: string; arguments: string }[] | undefined
    for (const part of cand?.content?.parts ?? []) {
      if (part.functionCall !== undefined) {
        const fc = part.functionCall
        const id = fc.id ?? `${fc.name}-${toolCalls?.length ?? 0}`
        if (part.thoughtSignature !== undefined) {
          this.signatures.set(id, part.thoughtSignature)
          this.signaturesStore?.upsert(id, part.thoughtSignature)
        }
        toolCalls = toolCalls ?? []
        toolCalls.push({
          id,
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        })
      } else if (part.thought === true && part.text) thoughtText = (thoughtText ?? '') + part.text
      else if (part.text) deltaText = (deltaText ?? '') + part.text
    }
    return {
      ...(deltaText !== undefined ? { deltaText } : {}),
      ...(thoughtText !== undefined ? { thoughtText } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(cand?.finishReason !== undefined ? { finishReason: cand.finishReason } : {}),
      ...this.usageFrom(resp),
    }
  }

  usageFrom(resp: NonNullable<StreamEnvelope['response']>): Partial<ChatChunk> {
    const u = resp.usageMetadata
    if (!u) return {}
    return {
      usage: {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: u.candidatesTokenCount ?? 0,
        totalTokens: u.totalTokenCount ?? 0,
        ...(u.thoughtsTokenCount !== undefined ? { thoughtTokens: u.thoughtsTokenCount } : {}),
        ...(u.cachedContentTokenCount !== undefined ? { cachedPromptTokens: u.cachedContentTokenCount } : {}),
      },
    }
  }

  /** Parses one `data:` SSE line; blank lines and non-data lines yield undefined. */
  parseSseLine(line: string): StreamEnvelope | undefined {
    if (!line.startsWith('data:')) return undefined
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return undefined
    try {
      return JSON.parse(payload) as StreamEnvelope
    } catch {
      return undefined
    }
  }
}
