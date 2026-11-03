export interface ModelQuotaInfo {
  readonly remainingFraction: number
  readonly resetTime: string
}

/** Input kinds a host can attach to a prompt (the vocabulary both opencode hosts use). */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

export interface ModelDescriptor {
  /** wire id, e.g. "gemini-3.6-flash-low" — used as opencode model id */
  readonly wireId: string
  readonly displayName: string
  readonly maxTokens: number
  readonly maxOutputTokens: number
  readonly supportsImages: boolean
  readonly supportsThinking: boolean
  readonly supportsVideo: boolean
  /** catalog `supportedMimeTypes` keys whose value is `true`, sorted; empty when the catalog lists none */
  readonly supportedMimeTypes: readonly string[]
  readonly thinkingBudget?: number
  readonly minThinkingBudget?: number
  readonly recommended: boolean
  readonly tagTitle?: string
  /** enum placeholder (MODEL_PLACEHOLDER_Mxx) required by request labels */
  readonly enumPlaceholder: string
  readonly quota?: ModelQuotaInfo
}
