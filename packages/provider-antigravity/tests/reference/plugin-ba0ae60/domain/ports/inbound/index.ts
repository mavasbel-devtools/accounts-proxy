import type { Account } from '@antigravity/domain/entities/Account.ts'
import type { QuotaSnapshot } from '@antigravity/domain/entities/QuotaSnapshot.ts'

export interface LoginResult {
  readonly account: Account
  readonly isNew: boolean
}

/**
 * Inbound port: host-driven interactive login (opencode auth login / /connect menu).
 */
export interface AuthLoginPort {
  /** Runs the full loopback OAuth flow; resolves once credentials are stored. */
  login(): Promise<LoginResult>
  /** Non-interactive probe of stored credential state. */
  status(): Promise<{ signedIn: boolean; email?: string }>
}

export interface ProviderModelContribution {
  readonly id: string
  readonly name: string
  readonly models: Readonly<Record<string, { name: string; limit?: { context: number; output: number; input?: number } }>>
  readonly options: Readonly<Record<string, unknown>>
}

/** Inbound port: contribute provider + dynamically discovered models to host config. */
export interface ProviderConfigPort {
  contribute(): Promise<ProviderModelContribution>
}

/** A tool the host exposes to the model (OpenAI-style function spec). */
export interface ToolSpec {
  readonly name: string
  readonly description?: string
  /** JSON-schema parameters, lowercase types as spoken by OpenAI-compatible hosts. */
  readonly parameters?: Record<string, unknown>
}

/** One tool invocation requested by the model. */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface ChatMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly text: string
  /** assistant-only: tool invocations the model requested in this turn. */
  readonly toolCalls?: readonly ToolCall[]
  /** tool-only: id of the invocation this message answers. */
  readonly toolCallId?: string
  /** tool-only: invoked tool name (Antigravity functionResponse requires it). */
  readonly toolName?: string
  /** user-only: inline attachments (images, PDF, audio, video), sent as Gemini `inlineData` parts. */
  readonly media?: readonly InlineMedia[]
}

export interface InlineMedia {
  readonly mimeType: string
  readonly base64: string
}

export interface ChatRequest {
  readonly modelWireId: string
  readonly messages: readonly ChatMessage[]
  readonly maxOutputTokens?: number
  readonly thinkingBudget?: number
  readonly tools?: readonly ToolSpec[]
  /** Catalog-resolved `labels.model_enum` placeholder (MODEL_*), injected by the relay. */
  readonly modelEnum?: string
}

export interface ChatChunk {
  readonly deltaText?: string
  readonly thoughtText?: string
  readonly toolCalls?: readonly ToolCall[]
  readonly finishReason?: string
  readonly usage?: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly totalTokens: number
    readonly thoughtTokens?: number
    /** Prompt tokens served from the upstream cache, when upstream reports them. */
    readonly cachedPromptTokens?: number
  }
}

/** Inbound port: streamed chat completion via the Antigravity transport. */
export interface ChatCompletionPort {
  stream(request: ChatRequest): AsyncIterable<ChatChunk>
}

/** Inbound port: account administration (menu commands). */
export interface AccountAdminPort {
  listAccounts(): Promise<readonly Account[]>
  selectAccount(id: string): Promise<void>
  toggleAccount(id: string): Promise<void>
}

/** Inbound port: quota reporting. */
export interface QuotaReportPort {
  currentQuota(): Promise<QuotaSnapshot | undefined>
}
