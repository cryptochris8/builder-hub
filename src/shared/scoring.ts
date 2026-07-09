import type { Project } from './types'

// Focus scoring + project health — harvested from FounderOS's scoring engine.
// Pure, dependency-free (no electron/fs) so it's unit-testable with Vitest.

/** Weighted focus score, 0-10 with one decimal. Higher = work on this next.
 *  Weights (FounderOS): revenue 30%, strategic 25%, excitement 20%,
 *  readiness 15%, remaining effort (inverted) 10%. Stage boosts for
 *  ready-for-build/launch-prep; blockers penalize. Unset inputs default to 5.
 *  (Deliberate change from FounderOS: 1-decimal instead of integer rounding,
 *  so the Today's Focus ranking is stable instead of full of ties.) */
export function calculateFocusScore(p: Project): number {
  const revenue = p.revenueScore ?? 5
  const strategic = p.strategicScore ?? 5
  const excitement = p.excitementScore ?? 5
  const readiness = p.readinessScore ?? 5
  const effort = p.effortScore ?? 5

  let score = revenue * 0.3 + strategic * 0.25 + excitement * 0.2 + readiness * 0.15 + (10 - effort) * 0.1

  if (p.stage === 'ready-for-build') score *= 1.1
  if (p.stage === 'launch-prep') score *= 1.15
  if (p.blockers && p.blockers.length > 0) score *= 0.8

  return Math.min(10, Math.round(score * 10) / 10)
}

export type HealthStatus = 'green' | 'yellow' | 'red'

export interface ProjectHealth {
  status: HealthStatus
  reasons: string[]
}

const STALE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/** Traffic-light health with the reasons behind it. 0 issues = green,
 *  1-2 = yellow, 3+ = red. `now` is injectable for tests. */
export function calculateHealth(p: Project, now = Date.now()): ProjectHealth {
  const issues: string[] = []

  if (!p.nextAction) issues.push('No next action set')
  if (p.blockers && p.blockers.length > 0) issues.push(`${p.blockers.length} blocker(s)`)

  // The Hub tracks opens as well as edits — either one counts as activity.
  const lastActivity = Math.max(p.updatedAt, p.lastOpenedAt ?? 0)
  if ((now - lastActivity) / DAY_MS > STALE_DAYS) issues.push('Not touched in 2+ weeks')

  if (!p.mvpDefinition && !p.currentFocus) issues.push('No focus or MVP defined')

  if (issues.length === 0) return { status: 'green', reasons: ['On track'] }
  if (issues.length <= 2) return { status: 'yellow', reasons: issues }
  return { status: 'red', reasons: issues }
}

/** Active projects ranked by focus score (descending) for the Today's Focus
 *  rail. Archived/idea projects don't compete for attention. */
export function rankByFocus(projects: Project[]): Project[] {
  return projects
    .filter((p) => p.status === 'active')
    .map((p) => ({ p, score: calculateFocusScore(p) }))
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p)
}
