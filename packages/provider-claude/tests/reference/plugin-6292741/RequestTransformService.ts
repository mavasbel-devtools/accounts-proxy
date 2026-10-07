import type { TransformContext } from './TransformContext.ts'
import { envelopeFor, type CatalogModelEntry } from './ModelEnvelope.ts'

/** One content block on the Anthropic wire. */
export interface WireBlock {
  readonly type: string
  readonly [key: string]: unknown
}

/** One message on the Anthropic wire (host-produced; roles may be non-standard). */
export interface WireMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content?: string | readonly WireBlock[]
  readonly [key: string]: unknown
}

/** Wire thinking shape accepted by Anthropic Messages API. */
export interface WireThinking {
  readonly type: string
  readonly display?: string
  readonly budget_tokens?: number
}

/** The host's anthropic messages request body (native wire, pre-transform). */
export interface WireRequestBody {
  readonly model?: string
  readonly messages: readonly WireMessage[]
  readonly system?: readonly { type: string; text: string; cache_control?: unknown }[] | string
  readonly tools?: readonly unknown[]
  readonly max_tokens?: number
  readonly thinking?: WireThinking | Record<string, unknown>
  readonly output_config?: { effort?: string } | Record<string, unknown>
  readonly stream?: boolean
  readonly [key: string]: unknown
}

/** Captured constants from real `claude` (see docs/research/claude-protocol/SPEC.md). */
export const CLAUDE_VERSION = '2.1.280.b1a'
export const CLAUDE_ENTRYPOINT = 'sdk-cli'
export const CLAUDE_CCH = 'ae63b'
export const SDK_PACKAGE_VERSION = '0.112.1'
export const ANTHROPIC_VERSION_HEADER = '2023-06-01'

/**
 * The captured beta header for the model. Unknown models take the haiku-safe
 * list unless the resolver supplies live capabilities for the id.
 */
export function betaHeaderFor(model: string | undefined, entry?: CatalogModelEntry): string {
  return envelopeFor(model, entry).betaHeader
}
export const ANTHROPIC_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const API_BASE = 'https://api.anthropic.com'
export const GRANTED_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

function billingBlock(ccPromptId: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}; cc_entrypoint=${CLAUDE_ENTRYPOINT}; cch=${CLAUDE_CCH}; cc_prompt_id=${ccPromptId};`,
  }
}

/**
 * Pure translation of a host anthropic wire into the captured real-claude
 * envelope, enforcing the prefill guard laws on every request:
 *
 * - L1 Tail: drop trailing `assistant` (incl. tool_use) and trailing `tool`
 *   messages until the last message is `user`; never empty.
 * - L2 Tool-role: mid-conversation `role:"tool"` → `user` + tool_result blocks
 *   (only when its tool_use id exists; else drop).
 * - L3 Tail-content: trailing tool_result blocks with no matching tool_use → drop.
 * - L4 Idempotence: re-applied on every retry.
 */
export class RequestTransformService {
  constructor(
    private readonly random: { uuid(): string; sha256Base64Url(input: string): string },
    private readonly apiBase: string = API_BASE,
    private readonly modelEntry?: (modelId: string) => CatalogModelEntry | undefined,
  ) {}

  /** Guard laws L1–L4 over the host messages array. */
  guardAndNormalize(messages: readonly WireMessage[]): WireMessage[] {
    // Collect every tool_use id so tool results can be validated (L2/L3).
    const toolUseIds = new Set<string>()
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id)
        }
      }
    }
    const out: WireMessage[] = []
    for (const m of messages) {
      if (m.role === 'tool') {
        const normalized = this.normalizeTool(m, toolUseIds)
        if (normalized) out.push(normalized)
      } else {
        out.push(m)
      }
    }
    // L3: strip trailing tool_result blocks that reference an unknown tool_use.
    this.dropDanglingToolResults(out, toolUseIds)
    // L1: trim trailing assistant/tool tails until the last turn is `user`
    // (or a converted tool_result user turn). A trailing `system` message is
    // VALID — the real claude wire ends on the deferred-tools system roster —
    // so it is never trimmed.
    while (out.length > 0 && (out[out.length - 1]!.role === 'assistant' || out[out.length - 1]!.role === 'tool')) out.pop()
    // Degenerate history with no user turn at all (never a valid prefill state).
    if (out.length === 0) out.push({ role: 'user', content: '' })
    return out
  }

  /**
   * L2: `role:"tool"` → `user` + tool_result block. Drops the message when
   * there is no resolvable result or the referenced tool_use is unknown.
   */
  private normalizeTool(m: WireMessage, toolUseIds: ReadonlySet<string>): WireMessage | null {
    const blocks = Array.isArray(m.content) ? m.content : []
    const toolResult = blocks.find(
      (b) => b.type === 'tool_result' || b.type === 'tool-result',
    ) as
      | { tool_use_id?: string; toolCallId?: string; content?: unknown; result?: unknown; is_error?: unknown; isError?: unknown }
      | undefined
    let id = toolResult?.tool_use_id ?? toolResult?.toolCallId ?? ''
    let result: unknown = toolResult?.content ?? toolResult?.result
    if (!toolResult && typeof m.content === 'string') {
      // Bare-string tool message: the content IS the result.
      id = (m as { tool_use_id?: string; toolCallId?: string }).tool_use_id ?? (m as { toolCallId?: string }).toolCallId ?? ''
      result = m.content
    }
    if (id === '' || !toolUseIds.has(id) || result === undefined) return null
    const isError = toolResult?.is_error ?? toolResult?.isError
    return {
      ...m,
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          ...(isError !== undefined ? { is_error: isError } : {}),
        },
      ],
    }
  }

  /** L3: removes tool_result blocks with no matching tool_use from the final user message. */
  private dropDanglingToolResults(messages: WireMessage[], toolUseIds: ReadonlySet<string>): void {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) return
    const blocks = last.content
    const hasDangling = blocks.some(
      (b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !toolUseIds.has(b.tool_use_id),
    )
    if (!hasDangling) return
    messages[messages.length - 1] = {
      ...last,
      content: blocks.filter(
        (b) => b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || toolUseIds.has(b.tool_use_id),
      ),
    }
  }

  /**
   * Full parity transform: guarded messages + captured envelope
   * (billing/identity system blocks, thinking, context_management,
   * output_config, diagnostics, metadata.user_id, headers, auth).
   */
  transform(
    input: { headers: Record<string, string>; body: WireRequestBody; path: string },
    ctx: TransformContext,
  ): { headers: Record<string, string>; url: string; body: string } {
    const messages = this.guardAndNormalize(input.body.messages)
    const body = this.envelope(input.body, messages, ctx)
    return {
      headers: this.headers(ctx, input.body.model),
      url: this.apiUrl(input.path),
      body: JSON.stringify(body),
    }
  }

  /** Upstream URL for a relay path, always carrying the beta flag. */
  apiUrl(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`
    return `${this.apiBase}${p}${p.includes('?') ? '&' : '?'}beta=true`
  }

  /** Captured-claude body envelope around the guarded host messages. */
  envelope(body: WireRequestBody, messages: readonly WireMessage[], ctx: TransformContext): WireRequestBody {
    const system = this.systemBlocks(body.system, ctx)
    const env = envelopeFor(body.model, this.modelEntry?.(body.model ?? ''))
    const thinking = sanitizeThinking(body.thinking, env.thinking)
    const outputConfig = sanitizeOutputConfig(body.output_config, env.outputConfig)
    return {
      ...body,
      messages: messages as WireMessage[],
      ...(system !== undefined ? { system } : {}),
      // Host values win; the captured envelope only fills what is absent.
      ...(body.max_tokens === undefined ? { max_tokens: env.maxTokens } : {}),
      thinking,
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      ...(outputConfig ? { output_config: outputConfig } : {}),
      diagnostics: { previous_message_id: ctx.previousMessageId },
      metadata: {
        user_id: JSON.stringify({
          device_id: ctx.deviceId,
          account_uuid: ctx.accountUuid,
          session_id: ctx.sessionId,
        }),
      },
    }
  }

  private systemBlocks(
    system: WireRequestBody['system'],
    ctx: TransformContext,
  ): readonly { type: string; text: string; cache_control?: unknown }[] | undefined {
    const ccPromptId = this.random.uuid()
    const billing = billingBlock(ccPromptId)
    const identity = { type: 'text' as const, text: ANTHROPIC_IDENTITY }
    if (system === undefined) return [billing, identity]
    const blocks = typeof system === 'string' ? [{ type: 'text' as const, text: system }] : [...system]
    return [billing, identity, ...blocks]
  }

  /** Captured-claude request header set (auth overridden with the fresh token). */
  headers(ctx: TransformContext, model?: string): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION_HEADER,
      'anthropic-beta': betaHeaderFor(model, this.modelEntry?.(model ?? '')),
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'x-cc-session-id': ctx.sessionId,
      'x-client-request-id': this.random.uuid(),
      'x-stainless-arch': 'x64',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'Windows',
      'x-stainless-package-version': SDK_PACKAGE_VERSION,
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v26.3.0',
      'x-stainless-timeout': '600',
      'user-agent': `claude-cli/${CLAUDE_VERSION} (external, ${CLAUDE_ENTRYPOINT})`,
    }
  }
}

/** Sanitizes thinking input to only allowed Anthropic wire fields. */
export function sanitizeThinking(
  thinking: unknown,
  fallback?: WireThinking,
): WireThinking {
  if (!thinking || typeof thinking !== 'object') {
    return fallback ? { ...fallback } : { type: 'adaptive', display: 'omitted' }
  }
  const t = thinking as Record<string, unknown>
  const type = typeof t.type === 'string' ? t.type : fallback?.type ?? 'adaptive'
  if (type === 'adaptive') {
    const display = typeof t.display === 'string' ? t.display : fallback?.display ?? 'omitted'
    return { type: 'adaptive', display }
  }
  if (type === 'enabled') {
    const rawBudget = t.budget_tokens ?? t.budgetTokens ?? fallback?.budget_tokens
    const budget_tokens =
      typeof rawBudget === 'number' && Number.isFinite(rawBudget)
        ? Math.max(1024, Math.floor(rawBudget))
        : 31999
    return { type: 'enabled', budget_tokens }
  }
  if (type === 'disabled') {
    return { type: 'disabled' }
  }
  return fallback ? { ...fallback } : { type: 'adaptive', display: 'omitted' }
}

/** Sanitizes output_config to only allowed Anthropic wire fields. */
export function sanitizeOutputConfig(
  outputConfig: unknown,
  fallback?: { readonly effort?: string },
): { effort: string } | undefined {
  if (outputConfig && typeof outputConfig === 'object') {
    const effort = (outputConfig as Record<string, unknown>).effort
    if (typeof effort === 'string' && effort.length > 0) {
      return { effort }
    }
  }
  if (fallback?.effort) {
    return { effort: fallback.effort }
  }
  return undefined
}

/** Parses the response message id out of an SSE body (`message_start` line). */
export function extractMessageId(sse: string): string | null {
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const payload = JSON.parse(line.slice(5).trim()) as { type?: string; message?: { id?: string } }
      if (payload.type === 'message_start' && payload.message?.id) return payload.message.id
    } catch {
      /* skip malformed data lines */
    }
  }
  return null
}

/**
 * Parses the terminal Anthropic stop reason from a relay response body.
 * Streaming responses carry it on the `message_delta` event
 * (`delta.stop_reason`, per the Anthropic Messages stream); a non-streaming
 * JSON body carries a top-level `stop_reason`. Returns the final non-null
 * reason seen (`"refusal"`, `"end_turn"`, `"tool_use"`, ...), or null when the
 * body carries none (e.g. a `count_tokens` response or an error body).
 */
export function extractStopReason(body: string): string | null {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed) as { stop_reason?: unknown }
      return typeof payload.stop_reason === 'string' ? payload.stop_reason : null
    } catch {
      /* not a JSON body; fall through to the SSE scan */
    }
  }
  let reason: string | null = null
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const payload = JSON.parse(line.slice(5).trim()) as {
        type?: string
        delta?: { stop_reason?: unknown }
        message?: { stop_reason?: unknown }
      }
      if (payload.type === 'message_delta' && typeof payload.delta?.stop_reason === 'string') {
        reason = payload.delta.stop_reason
      } else if (payload.type === 'message_start' && typeof payload.message?.stop_reason === 'string') {
        reason = payload.message.stop_reason
      }
    } catch {
      /* skip malformed data lines */
    }
  }
  return reason
}
