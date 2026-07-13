import type { Project } from './types'

// Focus scoring + project health — harvested from FounderOS's scoring engine.
// Pure, dependency-free (no electron/fs) so it's unit-testable with Vitest.

const STAGE_BOOST: Partial<Record<NonNullable<Project['stage']>, number>> = {
  'ready-for-build': 1.1,
  'launch-prep': 1.15
}
const BLOCKED_PENALTY = 0.8
/** The largest boost any project can get. The weights below already sum to a
 *  max of 10, so a boosted project overshoots 10 — we divide by this to land
 *  back in 0-10 instead of clamping. Clamping would tie EVERY high scorer at
 *  exactly 10 (base >= 8.7 saturates once boosted) and rankByFocus would then
 *  fall through to its alphabetical tiebreak, ranking a worse project above a
 *  better one. Dividing by a constant preserves the true ordering exactly. */
const MAX_BOOST = Math.max(...Object.values(STAGE_BOOST))

/** Weighted focus score, 0-10 with one decimal. Higher = work on this next.
 *  Weights (FounderOS): revenue 30%, strategic 25%, excitement 20%,
 *  readiness 15%, remaining effort (inverted) 10%. Stage boosts for
 *  ready-for-build/launch-prep; blockers penalize. Unset inputs default to 5.
 *  A perfect launch-prep project with no blockers is the only 10.0.
 *  (Deliberate change from FounderOS: 1-decimal instead of integer rounding,
 *  so the Today's Focus ranking is stable instead of full of ties.) */
export function calculateFocusScore(p: Project): number {
  const revenue = score(p.revenueScore)
  const strategic = score(p.strategicScore)
  const excitement = score(p.excitementScore)
  const readiness = score(p.readinessScore)
  const effort = score(p.effortScore)

  const base = revenue * 0.3 + strategic * 0.25 + excitement * 0.2 + readiness * 0.15 + (10 - effort) * 0.1

  let raw = base * (STAGE_BOOST[p.stage!] ?? 1)
  if (p.blockers && p.blockers.length > 0) raw *= BLOCKED_PENALTY

  return Math.round((raw / MAX_BOOST) * 10) / 10
}

/** A score input, coerced into 0-10. Anything unset or non-numeric (a
 *  hand-edited projects.json, a bad IPC payload) reads as the 5 default —
 *  a NaN here would otherwise render as "NaN" and poison the ranking sort. */
function score(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(10, v as number)) : 5
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
  // Both are ?? 0 because a missing timestamp makes Math.max NaN, and every
  // comparison against NaN is false — the project would never read as stale.
  const lastActivity = Math.max(p.updatedAt ?? 0, p.lastOpenedAt ?? 0)
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
