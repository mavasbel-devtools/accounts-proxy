export interface ModelQuotaInfo {
  readonly remainingFraction: number
  readonly resetTime: string
}

export interface ModelDescriptor {
  /** wire id, e.g. "gemini-3.6-flash-low" — used as opencode model id */
  readonly wireId: string
  readonly displayName: string
  readonly maxTokens: number
  readonly maxOutputTokens: number
  readonly supportsImages: boolean
  readonly supportsThinking: boolean
  readonly supportsVideo: boolean
  readonly thinkingBudget?: number
  readonly minThinkingBudget?: number
  readonly recommended: boolean
  readonly tagTitle?: string
  /** enum placeholder (MODEL_PLACEHOLDER_Mxx) required by request labels */
  readonly enumPlaceholder: string
  readonly quota?: ModelQuotaInfo
}
