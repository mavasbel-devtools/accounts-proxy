export interface QuotaBucket {
  readonly bucketId: string
  readonly displayName: string
  readonly window: string
  readonly resetTime: string
  readonly remainingFraction: number
}

export interface QuotaGroup {
  readonly displayName: string
  /** Raw server description, e.g. "Models within this group: Gemini Flash, …" */
  readonly description?: string
  readonly buckets: readonly QuotaBucket[]
}

export interface QuotaSnapshot {
  readonly groups: readonly QuotaGroup[]
  readonly capturedAt: number
}
