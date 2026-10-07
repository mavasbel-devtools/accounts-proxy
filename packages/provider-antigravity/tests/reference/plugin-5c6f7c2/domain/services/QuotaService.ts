import type { QuotaSnapshot } from '../../domain/entities/QuotaSnapshot.ts'

/** Maps the captured `retrieveUserQuotaSummary` response into a snapshot. */
export function toQuotaSnapshot(raw: Record<string, unknown>, capturedAt: number): QuotaSnapshot {
  const groups = (raw['groups'] ?? []) as Array<Record<string, unknown>>
  return {
    capturedAt,
    groups: groups.map((g) => ({
      displayName: String(g['displayName'] ?? ''),
      buckets: ((g['buckets'] ?? []) as Array<Record<string, unknown>>).map((b) => ({
        bucketId: String(b['bucketId'] ?? ''),
        displayName: String(b['displayName'] ?? ''),
        window: String(b['window'] ?? ''),
        resetTime: String(b['resetTime'] ?? ''),
        remainingFraction: Number(b['remainingFraction'] ?? 0),
      })),
      ...(typeof g['description'] === 'string' && g['description'].length > 0
        ? { description: g['description'] }
        : {}),
    })),
  }
}

/** Extracts the model list from a group description ("…group: A, B, C"). */
export function parseGroupModels(description: string | undefined): string[] {
  if (!description) return []
  const idx = description.indexOf(':')
  if (idx < 0) return []
  return description
    .slice(idx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const WINDOW_LABELS: Record<string, string> = {
  '5h': '5-hour limit',
  weekly: 'Weekly limit',
}

export interface UsageBucketView {
  readonly id: string
  readonly window: string
  readonly remainingPercent: number
  readonly resetAt: string
}

export interface UsageGroupView {
  readonly name: string
  readonly models: readonly string[]
  readonly buckets: readonly UsageBucketView[]
}

export interface UsageView {
  readonly capturedAt: number
  readonly groups: readonly UsageGroupView[]
  /** Compact human-readable table (JSON response carries the same data). */
  readonly text: string
}

/** Renders a snapshot into the user-facing usage view (per model group × window). */
export function formatUsage(snapshot: QuotaSnapshot): UsageView {
  const groups: UsageGroupView[] = snapshot.groups.map((g) => ({
    name: g.displayName,
    models: parseGroupModels(g.description),
    buckets: g.buckets.map((b) => ({
      id: b.bucketId,
      window: WINDOW_LABELS[b.window] ?? b.window,
      remainingPercent: Math.round(b.remainingFraction * 100),
      resetAt: b.resetTime,
    })),
  }))
  const lines: string[] = ['Antigravity usage:']
  for (const g of groups) {
    lines.push(`- ${g.name}${g.models.length > 0 ? ` (${g.models.join(', ')})` : ''}`)
    for (const b of g.buckets) {
      lines.push(`    ${b.window}: ${b.remainingPercent}% remaining, resets ${b.resetAt}`)
    }
  }
  return { capturedAt: snapshot.capturedAt, groups, text: lines.join('\n') }
}

export function lowestRemaining(snapshot: QuotaSnapshot): number | undefined {
  const all = snapshot.groups.flatMap((g) => g.buckets.map((b) => b.remainingFraction))
  return all.length ? Math.min(...all) : undefined
}
