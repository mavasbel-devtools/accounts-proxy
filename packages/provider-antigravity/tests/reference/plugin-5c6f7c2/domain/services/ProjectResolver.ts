import type { Account } from '@antigravity/domain/entities/Account.ts'

/**
 * Extracts usable project ids from a `loadCodeAssist` response.
 * Defensive by design: the exact response schema varies per tier; anything
 * unrecognizable yields an empty list (caller may then onboard).
 */
export function extractProjectIds(raw: Record<string, unknown>): string[] {
  const ids: string[] = []
  const direct = raw['projectId']
  if (typeof direct === 'string' && direct.length > 0) ids.push(direct)
  // observed ground truth: loadCodeAssist carries cloudaicompanionProject
  const companion = raw['cloudaicompanionProject']
  if (typeof companion === 'string' && companion.length > 0) ids.push(companion)

  for (const key of ['allowedProjects', 'projects']) {
    const list = raw[key]
    if (!Array.isArray(list)) continue
    for (const p of list) {
      if (typeof p === 'string' && p.length > 0) ids.push(p)
      else if (p !== null && typeof p === 'object') {
        const id = (p as Record<string, unknown>)['id']
        if (typeof id === 'string' && id.length > 0) ids.push(id)
      }
    }
  }
  return [...new Set(ids)]
}

export function pickActiveProject(account: Account): string | undefined {
  return account.activeProjectId ?? account.projectIds[0]
}
